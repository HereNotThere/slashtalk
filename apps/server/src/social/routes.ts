import { Elysia, t } from "elysia";
import { eq, sql, and, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, users, repos, userRepos, heartbeats } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { classifySessionState } from "../sessions/state";

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
          .limit(100);

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

        // Classify states and filter if requested
        const enriched = sessionRows.map((s) => {
          const hb = hbMap.get(s.sessionId);
          const state = classifySessionState({
            heartbeatUpdatedAt: hb?.updatedAt ?? null,
            inTurn: s.inTurn ?? false,
            lastTs: s.lastTs,
          });
          return { ...s, state };
        });

        if (query.state) {
          return enriched.filter((s) => s.state === query.state);
        }

        return enriched;
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
      // Get distinct users who share repos with me
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

      // Build response with session counts
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
