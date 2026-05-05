import { Elysia, t } from "elysia";
import { eq, sql, and, gt, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, users, repos, userRepos, heartbeats } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import {
  sharedRepoIdsForUsers,
  visiblePeerIdsForUser,
  visibleRepoIdsForUser,
} from "../repo/visibility";
import { sortByStateThenTime } from "../sessions/snapshot";
import { hydrateSessions } from "../sessions/read-model";
import { HEARTBEAT_FRESH_S } from "../sessions/state";
import { normalizeFullName } from "./github-sync";
import { loadChatHistory } from "../chat/history";

export const socialRoutes = (db: Database) =>
  new Elysia({ prefix: "/api", name: "social" })
    .use(jwtAuth)

    // GET /api/feed — sessions from user's social graph
    .get(
      "/feed",
      async ({ user, query }) => {
        // Get all repo IDs the user has access to
        const repoIds = await visibleRepoIdsForUser(db, user.id);
        if (repoIds.length === 0) return [];

        // Get sessions for those repos
        let sessionRows = await db
          .select()
          .from(sessions)
          .where(inArray(sessions.repoId, repoIds))
          .orderBy(sql`${sessions.lastTs} desc nulls last`)
          .limit(200);

        // Apply user filter
        if (query.user) {
          const [filterUser] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.githubLogin, query.user))
            .limit(1);
          if (filterUser) {
            sessionRows = sessionRows.filter((s) => s.userId === filterUser.id);
          } else {
            return [];
          }
        }

        // Apply repo filter
        if (query.repo) {
          const [filterRepo] = await db
            .select({ id: repos.id })
            .from(repos)
            .where(eq(repos.fullName, normalizeFullName(query.repo)))
            .limit(1);
          if (filterRepo) {
            sessionRows = sessionRows.filter((s) => s.repoId === filterRepo.id);
          } else {
            return [];
          }
        }

        // Build augmented snapshots
        let snapshots = (
          await hydrateSessions(db, sessionRows, {
            includeUsers: true,
            includeRepos: true,
          })
        ).map(({ snapshot, user: u, repo: r }) => {
          return {
            ...snapshot,
            github_login: u?.githubLogin ?? "unknown",
            avatar_url: u?.avatarUrl ?? null,
            repo_full_name: r?.fullName ?? null,
          };
        });

        // Apply state filter
        if (query.state) {
          snapshots = snapshots.filter((s) => s.state === query.state);
        }

        return sortByStateThenTime(snapshots);
      },
      {
        query: t.Object({
          tab: t.Optional(t.String()),
          user: t.Optional(t.String()),
          repo: t.Optional(t.String()),
          state: t.Optional(t.String()),
        }),
      },
    )

    // GET /api/feed/users — users in social graph with session counts
    .get("/feed/users", async ({ user }) => {
      const freshHeartbeatCutoff = new Date(Date.now() - HEARTBEAT_FRESH_S * 1000);
      const userIds = await visiblePeerIdsForUser(db, user.id);
      if (userIds.length === 0) return [];

      const peerUsers = await db.select().from(users).where(inArray(users.id, userIds));

      const [sessionCountRows, activeCountRows, peerRepoRows] = await Promise.all([
        db
          .select({
            userId: sessions.userId,
            count: sql<number>`count(*)`,
          })
          .from(sessions)
          .where(inArray(sessions.userId, userIds))
          .groupBy(sessions.userId),
        db
          .select({
            userId: sessions.userId,
            count: sql<number>`count(*)`,
          })
          .from(sessions)
          .innerJoin(heartbeats, eq(heartbeats.sessionId, sessions.sessionId))
          .where(
            and(inArray(sessions.userId, userIds), gt(heartbeats.updatedAt, freshHeartbeatCutoff)),
          )
          .groupBy(sessions.userId),
        db
          .select({
            userId: userRepos.userId,
            fullName: repos.fullName,
          })
          .from(userRepos)
          .innerJoin(repos, eq(repos.id, userRepos.repoId))
          .where(inArray(userRepos.userId, userIds)),
      ]);

      const sessionCountByUser = new Map(sessionCountRows.map((row) => [row.userId, row.count]));
      const activeCountByUser = new Map(activeCountRows.map((row) => [row.userId, row.count]));
      const reposByUser = new Map<number, string[]>();
      for (const row of peerRepoRows) {
        const existing = reposByUser.get(row.userId);
        if (existing) existing.push(row.fullName);
        else reposByUser.set(row.userId, [row.fullName]);
      }

      const result = [];
      for (const peer of peerUsers) {
        result.push({
          github_login: peer.githubLogin,
          avatar_url: peer.avatarUrl,
          total_sessions: sessionCountByUser.get(peer.id) ?? 0,
          active_sessions: activeCountByUser.get(peer.id) ?? 0,
          repos: reposByUser.get(peer.id) ?? [],
        });
      }

      return result;
    })

    // GET /api/users/:login/questions — that user's chat threads, gated for peer visibility.
    //
    //  Author gate: :login must share ≥1 repo with the caller (same social
    //  graph as /api/feed/users). Self-lookup is always allowed.
    //  Citation gate: a thread that originally contained citations is dropped
    //  if none of those cited sessions are visible to the caller (it was
    //  about repos they can't see). Uncited threads pass — visible to anyone
    //  in the asker's social graph.
    .get(
      "/users/:login/questions",
      async ({ user, params, set }) => {
        try {
          const [target] = await db
            .select({
              id: users.id,
              githubLogin: users.githubLogin,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
            })
            .from(users)
            .where(eq(users.githubLogin, params.login))
            .limit(1);
          if (!target) {
            set.status = 404;
            return { error: "user not found" };
          }

          if (target.id !== user.id) {
            // Author gate: callers can only see questions from teammates they
            // share a repo with. The query is symmetric to /api/feed/users.
            const overlap = await sharedRepoIdsForUsers(db, user.id, target.id);
            if (overlap.length === 0) {
              set.status = 403;
              return { error: "no_access" };
            }
          }

          const threads = await loadChatHistory(db, {
            viewerId: user.id,
            authorId: target.id,
            asker: {
              login: target.githubLogin,
              displayName: target.displayName,
              avatarUrl: target.avatarUrl,
            },
            dropThreadsWithOnlyHiddenCitations: true,
          });

          return { threads };
        } catch (err) {
          console.error("[social] /api/users/:login/questions failed:", err);
          set.status = 500;
          return { error: "questions request failed" };
        }
      },
      {
        params: t.Object({ login: t.String() }),
      },
    );
