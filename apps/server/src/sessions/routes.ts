import { Elysia, t } from "elysia";
import { eq, sql, and } from "drizzle-orm";
import { SessionState } from "@slashtalk/shared";
import type { Database } from "../db";
import { sessions, events } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { sortByStateThenTime } from "./snapshot";
import { hydrateSession, hydrateSessions } from "./read-model";
import { loadAccessibleSession } from "./access";

const SESSION_STATE_VALUES = Object.values(SessionState);

export const sessionRoutes = (db: Database) =>
  new Elysia({ prefix: "/api", name: "sessions" })
    .use(jwtAuth)

    // GET /api/sessions — user's own sessions
    .get(
      "/sessions",
      async ({ user, query }) => {
        // Fetch by recency, then re-sort by (state priority, lastTs). State
        // classification happens in JS from heartbeat + event aggregates, so
        // the canonical ordering can't be expressed in SQL.
        const rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, user.id))
          .orderBy(sql`${sessions.lastTs} desc nulls last`)
          .limit(100);

        let snapshots = (await hydrateSessions(db, rows)).map((s) => s.snapshot);

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
          state: t.Optional(t.Union(SESSION_STATE_VALUES.map((s) => t.Literal(s)))),
        }),
      },
    )

    // GET /api/session/:id — full session snapshot (own or shared repo)
    .get(
      "/session/:id",
      async ({ params, user, set }) => {
        const session = await loadAccessibleSession(db, params.id, user.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        return (await hydrateSession(db, session)).snapshot;
      },
      { params: t.Object({ id: t.String() }) },
    )

    // GET /api/session/:id/events — paginated event list
    .get(
      "/session/:id/events",
      async ({ params, query, user, set }) => {
        const session = await loadAccessibleSession(db, params.id, user.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        const limit = query.limit ?? 50;
        const cursor = query.cursor ?? null;
        const q = db
          .select()
          .from(events)
          .where(
            and(
              eq(events.sessionId, params.id),
              cursor != null ? sql`${events.lineSeq} > ${cursor}` : undefined,
            ),
          )
          .orderBy(sql`${events.lineSeq} asc`)
          .limit(limit);

        return await q;
      },
      {
        params: t.Object({ id: t.String() }),
        // Numeric: bare Number("abc") returned NaN, which Drizzle silently
        // accepted as `.limit(NaN)` and returned unbounded rows.
        query: t.Object({
          cursor: t.Optional(t.Numeric({ minimum: 0 })),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
        }),
      },
    );
