import { Elysia, t } from "elysia";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { jwtAuth } from "../auth/middleware";
import type { RedisBridge } from "../ws/redis-bridge";
import { repos, roomMembers, roomMessages, rooms, userRepos, users } from "../db/schema";
import { fetchUserGithubToken } from "../user/github-helpers";
import { userIsInOrg } from "./orgs";
import { e2bAdapter } from "./sandbox";
import { postMessage, provisionRoomAsync, runAgentTurnAsync } from "./runner";

const REPO_FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

async function userIsRoomMember(db: Database, roomId: string, userId: number): Promise<boolean> {
  const [r] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return !!r;
}

// Mirrors the repo-claim gate (CLAUDE.md #12): personal-namespace repos count
// as in-scope for their owner without an org-membership lookup. GitHub login
// comparisons are case-insensitive to match GitHub's own behavior — the
// stored case in repos.fullName may differ from users.githubLogin.
async function userCanAccessOrg(
  db: Database,
  user: { id: number; githubLogin: string },
  orgLogin: string,
): Promise<boolean> {
  if (orgLogin.toLowerCase() === user.githubLogin.toLowerCase()) return true;
  return userIsInOrg(db, user.id, orgLogin);
}

export const roomsRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/api/rooms", name: "rooms" })
    .use(jwtAuth)

    .post(
      "/",
      async ({ body, user, set }) => {
        if (!REPO_FULL_NAME.test(body.repoFullName)) {
          set.status = 400;
          return { error: "invalid repoFullName" };
        }
        const orgLogin = body.repoFullName.split("/")[0]!;
        if (!(await userCanAccessOrg(db, user, orgLogin))) {
          set.status = 403;
          return {
            error: `not a member of org "${orgLogin}" (signed in as ${user.githubLogin}). Check the server log for the GitHub /user/memberships/orgs response.`,
          };
        }

        const [repoRow] = await db
          .select({ repoId: repos.id })
          .from(repos)
          .innerJoin(userRepos, eq(userRepos.repoId, repos.id))
          .where(and(eq(repos.fullName, body.repoFullName), eq(userRepos.userId, user.id)))
          .limit(1);
        if (!repoRow) {
          set.status = 403;
          return { error: "repo not in user_repos — claim it first" };
        }

        // Prefer a user-supplied clone token if present (needed for private
        // repos — OAuth scope is read-only-orgs, can't access private repo
        // contents). Falls back to the OAuth token, which works for public
        // repos.
        const cloneTokenOverride = body.cloneToken?.trim();
        const cloneToken = cloneTokenOverride || (await fetchUserGithubToken(db, user.id));
        if (!cloneToken) {
          set.status = 401;
          return { error: "no clone token available" };
        }
        const cloneUrl = `https://x-access-token:${cloneToken}@github.com/${body.repoFullName}.git`;

        const agentDef = {
          systemPrompt: body.systemPrompt,
          model: body.model,
          mcpServers: body.mcpServers,
        };

        const [room] = await db
          .insert(rooms)
          .values({
            orgLogin,
            repoId: repoRow.repoId,
            createdBy: user.id,
            name: body.name,
            description: body.description ?? null,
            agentDef,
            sandboxProvider: "e2b",
            status: "provisioning",
          })
          .returning();
        await db.insert(roomMembers).values({ roomId: room!.id, userId: user.id, role: "owner" });

        void provisionRoomAsync(db, redis, room!.id, {
          repoCloneUrl: cloneUrl,
          gitUser: {
            name: user.displayName ?? user.githubLogin,
            email: `${user.githubLogin}@users.noreply.github.com`,
          },
          agentDef,
        });

        return { room: room! };
      },
      {
        body: t.Object({
          repoFullName: t.String(),
          name: t.String({ minLength: 1, maxLength: 200 }),
          description: t.Optional(t.String({ maxLength: 1000 })),
          systemPrompt: t.String({ minLength: 1, maxLength: 10000 }),
          model: t.String({ minLength: 1, maxLength: 200 }),
          mcpServers: t.Optional(t.Array(t.Object({ name: t.String(), url: t.String() }))),
          cloneToken: t.Optional(t.String({ maxLength: 1000 })),
        }),
      },
    )

    .get(
      "/",
      async ({ query, user, set }) => {
        const org = query.org?.trim();
        if (!org) {
          set.status = 400;
          return { error: "org query param required" };
        }
        if (!(await userCanAccessOrg(db, user, org))) {
          set.status = 403;
          return { error: `not a member of org "${org}" (signed in as ${user.githubLogin})` };
        }
        const list = await db
          .select()
          .from(rooms)
          .where(
            and(
              eq(rooms.orgLogin, org),
              inArray(rooms.status, ["provisioning", "ready", "paused"]),
            ),
          )
          .orderBy(desc(rooms.lastActivityAt))
          .limit(100);
        return { rooms: list };
      },
      { query: t.Object({ org: t.String() }) },
    )

    .get(
      "/:id",
      async ({ params, user, set }) => {
        const [room] = await db.select().from(rooms).where(eq(rooms.id, params.id)).limit(1);
        if (!room) {
          set.status = 404;
          return { error: "not found" };
        }
        if (!(await userCanAccessOrg(db, user, room.orgLogin))) {
          set.status = 403;
          return {
            error: `not a member of org "${room.orgLogin}" (signed in as ${user.githubLogin})`,
          };
        }
        const members = await db
          .select({
            userId: roomMembers.userId,
            role: roomMembers.role,
            joinedAt: roomMembers.joinedAt,
            githubLogin: users.githubLogin,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          })
          .from(roomMembers)
          .innerJoin(users, eq(users.id, roomMembers.userId))
          .where(eq(roomMembers.roomId, params.id));
        const messages = await db
          .select()
          .from(roomMessages)
          .where(eq(roomMessages.roomId, params.id))
          .orderBy(desc(roomMessages.seq))
          .limit(50);
        return { room, members, messages: messages.reverse() };
      },
      { params: t.Object({ id: t.String() }) },
    )

    .post(
      "/:id/join",
      async ({ params, user, set }) => {
        const [room] = await db.select().from(rooms).where(eq(rooms.id, params.id)).limit(1);
        if (!room) {
          set.status = 404;
          return { error: "not found" };
        }
        if (!(await userCanAccessOrg(db, user, room.orgLogin))) {
          set.status = 403;
          return {
            error: `not a member of org "${room.orgLogin}" (signed in as ${user.githubLogin})`,
          };
        }
        await db
          .insert(roomMembers)
          .values({ roomId: params.id, userId: user.id, role: "member" })
          .onConflictDoNothing();
        void redis.publish(`room:${params.id}`, {
          type: "room_member_joined",
          roomId: params.id,
          userId: user.id,
        });
        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    )

    .post(
      "/:id/messages",
      async ({ params, body, user, set }) => {
        if (!(await userIsRoomMember(db, params.id, user.id))) {
          set.status = 403;
          return { error: "not a room member" };
        }
        const { seq } = await postMessage(db, redis, params.id, user.id, "chat", {
          text: body.text,
        });
        await db.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.id, params.id));
        return { seq };
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ text: t.String({ minLength: 1, maxLength: 10000 }) }),
      },
    )

    .post(
      "/:id/agent",
      async ({ params, body, user, set }) => {
        if (!(await userIsRoomMember(db, params.id, user.id))) {
          set.status = 403;
          return { error: "not a room member" };
        }
        const [room] = await db.select().from(rooms).where(eq(rooms.id, params.id)).limit(1);
        if (!room) {
          set.status = 404;
          return { error: "not found" };
        }
        if (room.status !== "ready" && room.status !== "paused") {
          set.status = 409;
          return { error: `room status=${room.status}` };
        }
        // Persist the prompt as a chat message so transcripts make sense.
        await postMessage(db, redis, params.id, user.id, "chat", { text: body.prompt });
        void runAgentTurnAsync(db, redis, room, body.prompt);
        return { ok: true };
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ prompt: t.String({ minLength: 1, maxLength: 10000 }) }),
      },
    )

    .get(
      "/:id/messages",
      async ({ params, query, user, set }) => {
        if (!(await userIsRoomMember(db, params.id, user.id))) {
          set.status = 403;
          return { error: "not a room member" };
        }
        const after = query.after_seq ? parseInt(query.after_seq, 10) : 0;
        const list = await db
          .select()
          .from(roomMessages)
          .where(and(eq(roomMessages.roomId, params.id), gt(roomMessages.seq, after)))
          .orderBy(roomMessages.seq)
          .limit(500);
        return { messages: list };
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ after_seq: t.Optional(t.String()) }),
      },
    )

    .get(
      "/:id/patch",
      async ({ params, user, set }) => {
        if (!(await userIsRoomMember(db, params.id, user.id))) {
          set.status = 403;
          return { error: "not a room member" };
        }
        const [room] = await db.select().from(rooms).where(eq(rooms.id, params.id)).limit(1);
        if (!room?.sandboxId) {
          set.status = 404;
          return { error: "no sandbox" };
        }
        const diff = await e2bAdapter.diff(room.sandboxId);
        set.headers["content-type"] = "text/x-patch";
        set.headers["content-disposition"] = `attachment; filename="room-${params.id}.patch"`;
        return diff;
      },
      { params: t.Object({ id: t.String() }) },
    )

    .delete(
      "/:id",
      async ({ params, user, set }) => {
        const [room] = await db.select().from(rooms).where(eq(rooms.id, params.id)).limit(1);
        if (!room) {
          set.status = 404;
          return { error: "not found" };
        }
        if (room.createdBy !== user.id) {
          set.status = 403;
          return { error: "owner only" };
        }
        if (room.sandboxId) {
          try {
            await e2bAdapter.destroy(room.sandboxId);
          } catch (err) {
            console.warn("[rooms] destroy sandbox failed (continuing):", err);
          }
        }
        await db
          .update(rooms)
          .set({ status: "destroyed", destroyedAt: new Date() })
          .where(eq(rooms.id, params.id));
        void redis.publish(`room:${params.id}`, {
          type: "room_status_changed",
          roomId: params.id,
          status: "destroyed",
        });
        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    );
