import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, events, heartbeats } from "../db/schema";
import { apiKeyAuth } from "../auth/middleware";
import type { RedisBridge } from "../ws/redis-bridge";
import { processEvents, type EventPayload } from "./aggregator";
import { matchSessionRepo } from "../social/github-sync";
import { classifySessionState } from "../sessions/state";

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
        const acceptedPayloads: EventPayload[] = [];

        for (const line of lines) {
          const event = JSON.parse(line) as EventPayload;

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
            acceptedPayloads.push(event);
          } else {
            duplicateEvents++;
          }
        }

        const bodyBytes = new TextEncoder().encode(text).length;
        const newOffset = Number(query.fromOffset) + bodyBytes;

        // Prefix hash validation: if hash changed, reset offset
        let finalOffset = newOffset;
        if (query.prefixHash) {
          const [existing] = await db
            .select({ prefixHash: sessions.prefixHash })
            .from(sessions)
            .where(eq(sessions.sessionId, query.session))
            .limit(1);
          if (
            existing?.prefixHash &&
            existing.prefixHash !== query.prefixHash
          ) {
            // File was replaced/truncated — reset
            finalOffset = bodyBytes;
          }
        }

        // Upsert session record
        await db
          .insert(sessions)
          .values({
            sessionId: query.session,
            userId: user.id,
            deviceId: device?.id ?? null,
            project: query.project,
            serverOffset: finalOffset,
            prefixHash: query.prefixHash ?? null,
          })
          .onConflictDoUpdate({
            target: sessions.sessionId,
            set: {
              serverOffset: finalOffset,
              prefixHash: query.prefixHash ?? undefined,
            },
          });

        // Aggregate accepted events into session
        if (acceptedPayloads.length > 0) {
          const [currentSession] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.sessionId, query.session))
            .limit(1);

          if (currentSession) {
            const updates = processEvents(currentSession, acceptedPayloads);
            await db
              .update(sessions)
              .set(updates)
              .where(eq(sessions.sessionId, query.session));

            // Repo matching: if session has no repo_id, try to match
            if (!currentSession.repoId && updates.cwd) {
              const repoId = await matchSessionRepo(
                db,
                user.id,
                updates.cwd,
                query.project
              );
              if (repoId) {
                await db
                  .update(sessions)
                  .set({ repoId })
                  .where(eq(sessions.sessionId, query.session));
              }
            }

            // Publish to Redis
            const [refreshed] = await db
              .select({ repoId: sessions.repoId })
              .from(sessions)
              .where(eq(sessions.sessionId, query.session))
              .limit(1);

            if (refreshed?.repoId) {
              await redis.publish(`repo:${refreshed.repoId}`, {
                type: "session_updated",
                session_id: query.session,
                user_id: user.id,
                github_login: user.githubLogin,
                repo_id: refreshed.repoId,
                last_ts: updates.lastTs?.toISOString(),
              });
            }
          }
        }

        return {
          acceptedBytes: bodyBytes,
          acceptedEvents,
          duplicateEvents,
          serverOffset: finalOffset,
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
        // Get previous state for change detection
        const [prevHb] = await db
          .select()
          .from(heartbeats)
          .where(eq(heartbeats.sessionId, body.sessionId))
          .limit(1);

        const [session] = await db
          .select({ inTurn: sessions.inTurn, lastTs: sessions.lastTs, repoId: sessions.repoId })
          .from(sessions)
          .where(eq(sessions.sessionId, body.sessionId))
          .limit(1);

        const prevState = session
          ? classifySessionState({
              heartbeatUpdatedAt: prevHb?.updatedAt ?? null,
              inTurn: session.inTurn ?? false,
              lastTs: session.lastTs,
            })
          : null;

        // Upsert heartbeat
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

        // Check for state change → publish
        if (session) {
          const newState = classifySessionState({
            heartbeatUpdatedAt: new Date(),
            inTurn: session.inTurn ?? false,
            lastTs: session.lastTs,
          });

          if (newState !== prevState && session.repoId) {
            await redis.publish(`repo:${session.repoId}`, {
              type: "session_updated",
              session_id: body.sessionId,
              user_id: user.id,
              github_login: user.githubLogin,
              repo_id: session.repoId,
              state: newState,
            });
          }
        }

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
