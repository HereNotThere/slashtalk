import { Elysia, t } from "elysia";
import { eq, sql, and, lt } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, events, heartbeats } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { classifySessionState } from "./state";

export const sessionRoutes = (db: Database) =>
  new Elysia({ prefix: "/api", name: "sessions" })
    .use(jwtAuth)

    // GET /api/sessions — user's own sessions
    .get(
      "/sessions",
      async ({ user, query }) => {
        let rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, user.id))
          .orderBy(sql`${sessions.lastTs} desc nulls last`)
          .limit(100);

        // Get heartbeats for state classification
        const sessionIds = rows.map((s) => s.sessionId);
        const hbRows =
          sessionIds.length > 0
            ? await db
                .select()
                .from(heartbeats)
                .where(
                  sql`${heartbeats.sessionId} = ANY(${sessionIds})`
                )
            : [];
        const hbMap = new Map(hbRows.map((h) => [h.sessionId, h]));

        const enriched = rows.map((s) => {
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
          project: t.Optional(t.String()),
          state: t.Optional(t.String()),
        }),
      }
    )

    // GET /api/session/:id — full session snapshot
    .get(
      "/session/:id",
      async ({ params, user, set }) => {
        const [session] = await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.sessionId, params.id),
              eq(sessions.userId, user.id)
            )
          )
          .limit(1);

        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        const [hb] = await db
          .select()
          .from(heartbeats)
          .where(eq(heartbeats.sessionId, params.id))
          .limit(1);

        const state = classifySessionState({
          heartbeatUpdatedAt: hb?.updatedAt ?? null,
          inTurn: session.inTurn ?? false,
          lastTs: session.lastTs,
        });

        return { ...session, state };
      },
      { params: t.Object({ id: t.String() }) }
    )

    // GET /api/session/:id/events — paginated event list
    .get(
      "/session/:id/events",
      async ({ params, query, user, set }) => {
        // Verify session belongs to user
        const [session] = await db
          .select({ sessionId: sessions.sessionId })
          .from(sessions)
          .where(
            and(
              eq(sessions.sessionId, params.id),
              eq(sessions.userId, user.id)
            )
          )
          .limit(1);

        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        const limit = Math.min(Number(query.limit ?? 50), 100);
        let q = db
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
