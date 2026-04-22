import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, events, heartbeats } from "../db/schema";
import { apiKeyAuth } from "../auth/middleware";
import type { RedisBridge } from "../ws/redis-bridge";

export const ingestRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/v1", name: "ingest" })
    .use(apiKeyAuth)
    // Parse application/x-ndjson as text
    .onParse({ as: "local" }, async ({ request, contentType }) => {
      if (
        contentType === "application/x-ndjson" ||
        contentType === "text/plain"
      ) {
        return await request.text();
      }
    })

    // POST /v1/ingest — upload NDJSON event chunk
    .post(
      "/ingest",
      async ({ body, query, user, device }) => {
        const text = typeof body === "string" ? body : String(body);
        const lines = text.split("\n").filter((l) => l.trim().length > 0);

        let acceptedEvents = 0;
        let duplicateEvents = 0;

        for (const line of lines) {
          const event = JSON.parse(line);

          // Upsert event — dedup by UUID
          const result = await db
            .insert(events)
            .values({
              uuid: event.uuid,
              userId: user.id,
              sessionId: query.session,
              project: query.project,
              ts: new Date(event.timestamp),
              type: event.type,
              parentUuid: event.parentUuid ?? null,
              byteOffset: Number(query.fromOffset) ?? null,
              payload: event,
            })
            .onConflictDoNothing({ target: events.uuid })
            .returning();

          if (result.length > 0) {
            acceptedEvents++;
          } else {
            duplicateEvents++;
          }
        }

        // Upsert session record
        const bodyBytes = new TextEncoder().encode(text).length;
        const newOffset = Number(query.fromOffset) + bodyBytes;

        await db
          .insert(sessions)
          .values({
            sessionId: query.session,
            userId: user.id,
            deviceId: device?.id ?? null,
            project: query.project,
            serverOffset: newOffset,
            prefixHash: query.prefixHash ?? null,
          })
          .onConflictDoUpdate({
            target: sessions.sessionId,
            set: {
              serverOffset: newOffset,
              prefixHash: query.prefixHash ?? undefined,
            },
          });

        // Publish to Redis if session is linked to a repo
        if (acceptedEvents > 0) {
          const [session] = await db
            .select({ repoId: sessions.repoId })
            .from(sessions)
            .where(eq(sessions.sessionId, query.session))
            .limit(1);

          if (session?.repoId) {
            await redis.publish(`repo:${session.repoId}`, {
              type: "session_updated",
              session_id: query.session,
              user_id: user.id,
              github_login: user.githubLogin,
              repo_id: session.repoId,
            });
          }
        }

        return {
          acceptedBytes: bodyBytes,
          acceptedEvents,
          duplicateEvents,
          serverOffset: newOffset,
        };
      },
      {
        query: t.Object({
          project: t.String(),
          session: t.String(),
          fromOffset: t.String(),
          prefixHash: t.Optional(t.String()),
        }),
      }
    )

    // GET /v1/sync-state — get server-side sync state for resume
    .get("/sync-state", async ({ user }) => {
      const rows = await db
        .select({
          sessionId: sessions.sessionId,
          serverOffset: sessions.serverOffset,
          prefixHash: sessions.prefixHash,
        })
        .from(sessions)
        .where(eq(sessions.userId, user.id));

      const state: Record<
        string,
        { serverOffset: number; prefixHash: string | null }
      > = {};
      for (const row of rows) {
        state[row.sessionId] = {
          serverOffset: row.serverOffset ?? 0,
          prefixHash: row.prefixHash,
        };
      }
      return state;
    })

    // POST /v1/heartbeat — session heartbeat
    .post(
      "/heartbeat",
      async ({ body, user, device }) => {
        await db
          .insert(heartbeats)
          .values({
            sessionId: body.sessionId,
            userId: user.id,
            deviceId: device?.id ?? null,
            pid: body.pid ?? null,
            kind: body.kind ?? null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: heartbeats.sessionId,
            set: {
              pid: body.pid ?? null,
              kind: body.kind ?? null,
              updatedAt: new Date(),
            },
          });

        return { ok: true };
      },
      {
        body: t.Object({
          sessionId: t.String(),
          pid: t.Optional(t.Number()),
          kind: t.Optional(t.String()),
          cwd: t.Optional(t.String()),
          version: t.Optional(t.String()),
          startedAt: t.Optional(t.String()),
        }),
      }
    );
