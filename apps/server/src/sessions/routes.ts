import { Elysia, t } from "elysia";
import { eq, sql, and, lt, or, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, events, heartbeats, userRepos } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { classifySessionState } from "./state";
import { toSnapshot, sortByStateThenTime } from "./snapshot";

export const sessionRoutes = (db: Database) =>
  new Elysia({ prefix: "/api", name: "sessions" })
    .use(jwtAuth)

    // GET /api/sessions — user's own sessions
    .get(
      "/sessions",
      async ({ user, query }) => {
        const rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, user.id))
          .orderBy(sql`${sessions.lastTs} desc nulls last`)
          .limit(100);

        const sessionIds = rows.map((s) => s.sessionId);
        const hbRows =
          sessionIds.length > 0
            ? await db
                .select()
                .from(heartbeats)
                .where(inArray(heartbeats.sessionId, sessionIds))
            : [];
        const hbMap = new Map(hbRows.map((h) => [h.sessionId, h]));

        let snapshots = rows.map((s) => {
          const hb = hbMap.get(s.sessionId) ?? null;
          return toSnapshot(s, hb);
        });

        if (query.state) {
          snapshots = snapshots.filter((s) => s.state === query.state);
        }
        if (query.project) {
          snapshots = snapshots.filter((s) => s.project === query.project);
        }

        return sortByStateThenTime(snapshots);
      },
      {
        query: t.Object({
          project: t.Optional(t.String()),
          state: t.Optional(t.String()),
        }),
      }
    )

    // GET /api/session/:id — full session snapshot (own or shared repo)
    .get(
      "/session/:id",
      async ({ params, user, set }) => {
        const [session] = await db
          .select()
          .from(sessions)
          .where(eq(sessions.sessionId, params.id))
          .limit(1);

        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        // Access control: user owns session OR session is in a shared repo
        if (session.userId !== user.id) {
          if (!session.repoId) {
            set.status = 404;
            return { error: "Session not found" };
          }
          const [access] = await db
            .select()
            .from(userRepos)
            .where(
              and(
                eq(userRepos.userId, user.id),
                eq(userRepos.repoId, session.repoId)
              )
            )
            .limit(1);
          if (!access) {
            set.status = 404;
            return { error: "Session not found" };
          }
        }

        const [hb] = await db
          .select()
          .from(heartbeats)
          .where(eq(heartbeats.sessionId, params.id))
          .limit(1);

        return toSnapshot(session, hb ?? null);
      },
      { params: t.Object({ id: t.String() }) }
    )

    // GET /api/session/:id/events — paginated event list
    .get(
      "/session/:id/events",
      async ({ params, query, user, set }) => {
        // Verify access (own session or shared repo)
        const [session] = await db
          .select({
            sessionId: sessions.sessionId,
            userId: sessions.userId,
            repoId: sessions.repoId,
          })
          .from(sessions)
          .where(eq(sessions.sessionId, params.id))
          .limit(1);

        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        if (session.userId !== user.id) {
          if (!session.repoId) {
            set.status = 404;
            return { error: "Session not found" };
          }
          const [access] = await db
            .select()
            .from(userRepos)
            .where(
              and(
                eq(userRepos.userId, user.id),
                eq(userRepos.repoId, session.repoId)
              )
            )
            .limit(1);
          if (!access) {
            set.status = 404;
            return { error: "Session not found" };
          }
        }

        const limit = Math.min(Number(query.limit ?? 50), 100);
        const q = db
          .select()
          .from(events)
          .where(
            and(
              eq(events.sessionId, params.id),
              query.cursor
                ? lt(
                    events.ts,
                    db
                      .select({ ts: events.ts })
                      .from(events)
                      .where(eq(events.uuid, query.cursor))
                  )
                : undefined
            )
          )
          .orderBy(sql`${events.ts} asc`)
          .limit(limit);

        return await q;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          cursor: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      }
    );
