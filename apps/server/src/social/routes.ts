import { Elysia, t } from "elysia";
import { eq, sql, and, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, users, repos, userRepos, heartbeats } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { toSnapshot, sortByStateThenTime } from "../sessions/snapshot";
import { normalizeFullName } from "./github-sync";

export const socialRoutes = (db: Database) =>
  new Elysia({ prefix: "/api", name: "social" })
    .use(jwtAuth)

    // GET /api/feed — sessions from user's social graph
    .get(
      "/feed",
      async ({ user, query }) => {
        // Get all repo IDs the user has access to
        const myRepoIds = await db
          .select({ repoId: userRepos.repoId })
          .from(userRepos)
          .where(eq(userRepos.userId, user.id));

        const repoIds = myRepoIds.map((r) => r.repoId);
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
            sessionRows = sessionRows.filter(
              (s) => s.userId === filterUser.id
            );
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
            sessionRows = sessionRows.filter(
              (s) => s.repoId === filterRepo.id
            );
          } else {
            return [];
          }
        }

        // Get heartbeats for state classification
        const sessionIds = sessionRows.map((s) => s.sessionId);
        const hbRows =
          sessionIds.length > 0
            ? await db
                .select()
                .from(heartbeats)
                .where(inArray(heartbeats.sessionId, sessionIds))
            : [];
        const hbMap = new Map(hbRows.map((h) => [h.sessionId, h]));

        // Get user info for augmentation
        const userIds = [...new Set(sessionRows.map((s) => s.userId))];
        const userRows =
          userIds.length > 0
            ? await db
                .select({
                  id: users.id,
                  githubLogin: users.githubLogin,
                  avatarUrl: users.avatarUrl,
                })
                .from(users)
                .where(inArray(users.id, userIds))
            : [];
        const userMap = new Map(userRows.map((u) => [u.id, u]));

        // Get repo info for augmentation
        const repoIdSet = [
          ...new Set(
            sessionRows.map((s) => s.repoId).filter(Boolean) as number[]
          ),
        ];
        const repoRows =
          repoIdSet.length > 0
            ? await db
                .select({ id: repos.id, fullName: repos.fullName })
                .from(repos)
                .where(inArray(repos.id, repoIdSet))
            : [];
        const repoMap = new Map(repoRows.map((r) => [r.id, r]));

        // Build augmented snapshots
        let snapshots = sessionRows.map((s) => {
          const hb = hbMap.get(s.sessionId) ?? null;
          const snapshot = toSnapshot(s, hb);
          const u = userMap.get(s.userId);
          const r = s.repoId ? repoMap.get(s.repoId) : null;
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
      }
    )

    // GET /api/feed/users — users in social graph with session counts
    .get("/feed/users", async ({ user }) => {
      const peerUserIds = await db
        .selectDistinct({ userId: userRepos.userId })
        .from(userRepos)
        .where(
          inArray(
            userRepos.repoId,
            db
              .select({ repoId: userRepos.repoId })
              .from(userRepos)
              .where(eq(userRepos.userId, user.id))
          )
        );

      const userIds = peerUserIds
        .map((r) => r.userId)
        .filter((id) => id !== user.id);
      if (userIds.length === 0) return [];

      const peerUsers = await db
        .select()
        .from(users)
        .where(inArray(users.id, userIds));

      const result = [];
      for (const peer of peerUsers) {
        const sessionCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(sessions)
          .where(eq(sessions.userId, peer.id));

        const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
        const activeCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, peer.id),
              sql`${sessions.lastTs} > ${fifteenMinAgo}`
            )
          );

        const peerRepos = await db
          .select({ fullName: repos.fullName })
          .from(userRepos)
          .innerJoin(repos, eq(repos.id, userRepos.repoId))
          .where(eq(userRepos.userId, peer.id));

        result.push({
          github_login: peer.githubLogin,
          avatar_url: peer.avatarUrl,
          total_sessions: sessionCount[0]?.count ?? 0,
          active_sessions: activeCount[0]?.count ?? 0,
          repos: peerRepos.map((r) => r.fullName),
        });
      }

      return result;
    });
