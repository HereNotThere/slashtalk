import { Elysia, t } from "elysia";
import { eq, and } from "drizzle-orm";
import type { Database } from "../db";
import {
  users,
  devices,
  repos,
  userRepos,
  setupTokens,
  apiKeys,
  deviceExcludedRepos,
  deviceRepoPaths,
} from "../db/schema";
import { jwtAuth } from "../auth/middleware";

// "owner/name" — GitHub's constraints apply: 1-39 chars for owner, 1-100 for name.
const FULL_NAME = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const userRoutes = (db: Database) =>
  new Elysia({ prefix: "/api/me", name: "user" })
    .use(jwtAuth)

    // GET /api/me — current user profile
    .get("/", ({ user }) => ({
      id: user.id,
      githubLogin: user.githubLogin,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      createdAt: user.createdAt,
    }))

    // GET /api/me/devices — list user's devices
    .get("/devices", async ({ user }) => {
      return await db
        .select()
        .from(devices)
        .where(eq(devices.userId, user.id));
    })

    // DELETE /api/me/devices/:id — remove a device + its API key
    .delete(
      "/devices/:id",
      async ({ params, user, set }) => {
        const [device] = await db
          .select()
          .from(devices)
          .where(
            and(eq(devices.id, Number(params.id)), eq(devices.userId, user.id))
          )
          .limit(1);

        if (!device) {
          set.status = 404;
          return { error: "Device not found" };
        }

        await db.delete(apiKeys).where(eq(apiKeys.deviceId, device.id));
        await db.delete(devices).where(eq(devices.id, device.id));

        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) }
    )

    // GET /api/me/repos — list repos the user has claimed
    .get("/repos", async ({ user }) => {
      return await db
        .select({
          repoId: repos.id,
          fullName: repos.fullName,
          owner: repos.owner,
          name: repos.name,
          private: repos.private,
          permission: userRepos.permission,
          syncedAt: userRepos.syncedAt,
        })
        .from(userRepos)
        .innerJoin(repos, eq(repos.id, userRepos.repoId))
        .where(eq(userRepos.userId, user.id));
    })

    // POST /api/me/repos — claim a repo by "owner/name". Upserts into the
    // repos table and asserts the calling user tracks it. No GitHub API call
    // happens here — under read-only OAuth we can't verify repo access
    // server-side, so the client proves possession another way (e.g. the
    // desktop app only offers repos it found via a local .git/config).
    .post(
      "/repos",
      async ({ user, body, set }) => {
        const fullName = body.fullName.trim();
        if (!FULL_NAME.test(fullName)) {
          set.status = 400;
          return { error: "fullName must be in owner/name form" };
        }
        const [ownerLogin, name] = fullName.split("/");

        const [repo] = await db
          .insert(repos)
          .values({ fullName, owner: ownerLogin, name, private: body.private ?? false })
          .onConflictDoUpdate({
            target: repos.fullName,
            // touch so returning() always yields the row
            set: { owner: ownerLogin, name },
          })
          .returning();

        await db
          .insert(userRepos)
          .values({
            userId: user.id,
            repoId: repo.id,
            permission: "claimed",
            syncedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [userRepos.userId, userRepos.repoId],
          });

        return {
          repoId: repo.id,
          fullName: repo.fullName,
          owner: repo.owner,
          name: repo.name,
          private: repo.private ?? false,
          permission: "claimed",
          syncedAt: new Date().toISOString(),
        };
      },
      {
        body: t.Object({
          fullName: t.String({ minLength: 3, maxLength: 140 }),
          private: t.Optional(t.Boolean()),
        }),
      }
    )

    // DELETE /api/me/repos/:repoId — stop tracking a repo
    .delete(
      "/repos/:repoId",
      async ({ user, params }) => {
        await db
          .delete(userRepos)
          .where(
            and(
              eq(userRepos.userId, user.id),
              eq(userRepos.repoId, Number(params.repoId))
            )
          );
        return { ok: true };
      },
      { params: t.Object({ repoId: t.String() }) }
    )

    // POST /api/me/setup-token — generate a new setup token
    .post("/setup-token", async ({ user }) => {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await db.insert(setupTokens).values({
        userId: user.id,
        token,
        expiresAt,
      });

      return { token, expiresAt: expiresAt.toISOString() };
    });

/**
 * Device repos management — reported by install script.
 * Mounted separately at /v1/devices prefix.
 */
export const deviceReposRoutes = (db: Database) =>
  new Elysia({ prefix: "/v1/devices", name: "device-repos" })
    .use(
      // Use API key auth (imported inline to avoid circular dep)
      new Elysia({ name: "device-repos/auth" }).derive(
        { as: "scoped" },
        async ({ headers, set }) => {
          const { apiKeyAuth } = await import("../auth/middleware");
          // Reuse the apiKeyAuth derive logic inline
          const authHeader = headers.authorization;
          if (!authHeader?.startsWith("Bearer ")) {
            set.status = 401;
            throw new Error("Missing API key");
          }
          const { hashToken } = await import("../auth/tokens");
          const key = authHeader.slice(7);
          const keyHash = await hashToken(key);
          const [apiKey] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.keyHash, keyHash))
            .limit(1);
          if (!apiKey) {
            set.status = 401;
            throw new Error("Invalid API key");
          }
          const [user] = await db
            .select()
            .from(users)
            .where(eq(users.id, apiKey.userId))
            .limit(1);
          if (!user) {
            set.status = 401;
            throw new Error("User not found");
          }
          const [device] = await db
            .select()
            .from(devices)
            .where(eq(devices.id, apiKey.deviceId))
            .limit(1);
          return { user, device: device ?? null };
        }
      )
    )

    // POST /v1/devices/:id/repos — set repo paths and exclusions for a device
    .post(
      "/:id/repos",
      async ({ params, body, user, device, set }) => {
        const deviceId = Number(params.id);

        // Verify device belongs to user
        const [dev] = await db
          .select()
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
          .limit(1);

        if (!dev) {
          set.status = 404;
          return { error: "Device not found" };
        }

        // Store local path → repo mappings (from install-time discovery)
        if (body.repoPaths && body.repoPaths.length > 0) {
          await db
            .delete(deviceRepoPaths)
            .where(eq(deviceRepoPaths.deviceId, deviceId));

          await db.insert(deviceRepoPaths).values(
            body.repoPaths.map(
              (rp: { repoId: number; localPath: string }) => ({
                deviceId,
                repoId: rp.repoId,
                localPath: rp.localPath,
              })
            )
          );
        }

        // Store exclusions
        await db
          .delete(deviceExcludedRepos)
          .where(eq(deviceExcludedRepos.deviceId, deviceId));

        if (body.excludedRepoIds && body.excludedRepoIds.length > 0) {
          await db.insert(deviceExcludedRepos).values(
            body.excludedRepoIds.map((repoId: number) => ({
              deviceId,
              repoId,
            }))
          );
        }

        return { ok: true };
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          repoPaths: t.Optional(
            t.Array(
              t.Object({ repoId: t.Number(), localPath: t.String() })
            )
          ),
          excludedRepoIds: t.Optional(t.Array(t.Number())),
        }),
      }
    );
