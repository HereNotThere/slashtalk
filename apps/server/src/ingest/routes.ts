import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import {
  SOURCES,
  type EventSource,
  type IngestResponse,
  type SessionUpdatedMessage,
  type SyncStateEntry,
} from "@slashtalk/shared";
import type { Database } from "../db";
import { sessions, events, heartbeats } from "../db/schema";
import { apiKeyAuth } from "../auth/middleware";
import type { RedisBridge } from "../ws/redis-bridge";
import { classifyEvent } from "./classifier";
import { processEvents } from "./aggregator";
import { matchSessionRepo } from "../social/github-sync";
import { classifySessionState } from "../sessions/state";

interface ParsedLine {
  lineSeq: number;
  event: unknown;
}

/**
 * Parse an NDJSON chunk into numbered lines starting at `fromLineSeq`. Every
 * `\n`-delimited line consumes one seq; blank and malformed lines are dropped
 * but still consume their seq so client and server stay aligned on retries.
 */
function parseChunk(
  text: string,
  fromLineSeq: number,
): { parsed: ParsedLine[]; nextLineSeq: number } {
  if (text.length === 0) return { parsed: [], nextLineSeq: fromLineSeq };

  const rawLines = text.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();

  const parsed: ParsedLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim().length === 0) continue;
    try {
      parsed.push({ lineSeq: fromLineSeq + i, event: JSON.parse(line) });
    } catch {
      // intentional: don't fail the batch on a mid-flush partial line
    }
  }
  return { parsed, nextLineSeq: fromLineSeq + rawLines.length };
}

export const ingestRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/v1", name: "ingest" })
    .use(apiKeyAuth)
    .onParse({ as: "local" }, async ({ request, contentType }) => {
      if (contentType === "application/x-ndjson" || contentType === "text/plain") {
        return await request.text();
      }
    })

    // POST /v1/ingest — upload NDJSON event chunk
    .post(
      "/ingest",
      async ({ body, query, user, device }): Promise<IngestResponse> => {
        const source: EventSource = query.source ?? "claude";
        // onParse above returns the chunk as a string already.
        const text = body as string;
        const fromLineSeq = Number(query.fromLineSeq);
        const { parsed, nextLineSeq } = parseChunk(text, fromLineSeq);

        if (nextLineSeq === fromLineSeq) {
          return {
            acceptedEvents: 0,
            duplicateEvents: 0,
            serverLineSeq: fromLineSeq,
          };
        }

        let acceptedEvents = 0;
        let duplicateEvents = 0;
        const acceptedPayloads: unknown[] = [];

        // Ensure the parent session row exists before inserting child events.
        // Some callers upload a brand-new session without a prior session upsert.
        await db
          .insert(sessions)
          .values({
            sessionId: query.session,
            userId: user.id,
            deviceId: device?.id ?? null,
            source,
            project: query.project,
            serverLineSeq: nextLineSeq,
            prefixHash: query.prefixHash ?? null,
          })
          .onConflictDoUpdate({
            target: sessions.sessionId,
            set: {
              serverLineSeq: nextLineSeq,
              prefixHash: query.prefixHash ?? undefined,
            },
          });

        if (parsed.length > 0) {
          const rows = parsed.map(({ lineSeq, event }) => {
            const n = classifyEvent(source, event);
            return {
              sessionId: query.session,
              lineSeq,
              userId: user.id,
              project: query.project,
              source,
              ts: n.ts,
              rawType: n.rawType,
              kind: n.kind,
              turnId: n.turnId,
              callId: n.callId,
              eventId: n.eventId,
              parentId: n.parentId,
              payload: event,
            };
          });

          const inserted = await db
            .insert(events)
            .values(rows)
            .onConflictDoNothing({
              target: [events.sessionId, events.lineSeq],
            })
            .returning({ lineSeq: events.lineSeq });
          acceptedEvents = inserted.length;
          duplicateEvents = rows.length - acceptedEvents;

          // Correlate returned line_seqs back to the raw payloads so the
          // aggregator only sees events that actually inserted.
          const acceptedSet = new Set(inserted.map((r) => r.lineSeq));
          for (const { lineSeq, event } of parsed) {
            if (acceptedSet.has(lineSeq)) acceptedPayloads.push(event);
          }
        }

        if (acceptedPayloads.length > 0) {
          const [currentSession] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.sessionId, query.session))
            .limit(1);

          if (currentSession) {
            const updates = processEvents(source, currentSession, acceptedPayloads);
            await db.update(sessions).set(updates).where(eq(sessions.sessionId, query.session));

            // Retry while repo_id unresolved; fall back to the session's
            // stored cwd so strategy 3 (project-slug) can fire even when no
            // event has ever carried a cwd.
            if (!currentSession.repoId) {
              const cwd = updates.cwd ?? currentSession.cwd ?? null;
              const repoId = await matchSessionRepo(db, user.id, cwd, query.project, device?.id);
              if (repoId) {
                await db
                  .update(sessions)
                  .set({ repoId })
                  .where(eq(sessions.sessionId, query.session));
              }
            }
          }
        }

        if (acceptedEvents > 0) {
          const [finalSession] = await db
            .select({
              repoId: sessions.repoId,
              lastTs: sessions.lastTs,
            })
            .from(sessions)
            .where(eq(sessions.sessionId, query.session))
            .limit(1);

          // Only publish when we've resolved a repo — clients dedupe by
          // receiving exactly once via `repo:<id>`. The session owner's own
          // cache is already invalidated locally by `uploader.onIngested`,
          // so we don't need a user-channel echo.
          if (finalSession?.repoId) {
            const msg: SessionUpdatedMessage = {
              type: "session_updated",
              session_id: query.session,
              user_id: user.id,
              github_login: user.githubLogin,
              repo_id: finalSession.repoId,
              last_ts: finalSession.lastTs?.toISOString(),
            };
            await redis.publish(`repo:${finalSession.repoId}`, msg);
          }
        }

        return {
          acceptedEvents,
          duplicateEvents,
          serverLineSeq: nextLineSeq,
        };
      },
      {
        query: t.Object({
          project: t.String(),
          session: t.String(),
          fromLineSeq: t.String(),
          prefixHash: t.Optional(t.String()),
          source: t.Optional(t.Union(SOURCES.map((s) => t.Literal(s)))),
        }),
      },
    )

    // GET /v1/sync-state — get server-side sync state for resume
    .get("/sync-state", async ({ user }): Promise<Record<string, SyncStateEntry>> => {
      const rows = await db
        .select({
          sessionId: sessions.sessionId,
          serverLineSeq: sessions.serverLineSeq,
          prefixHash: sessions.prefixHash,
        })
        .from(sessions)
        .where(eq(sessions.userId, user.id));

      const state: Record<string, SyncStateEntry> = {};
      for (const row of rows) {
        state[row.sessionId] = {
          serverLineSeq: row.serverLineSeq ?? 0,
          prefixHash: row.prefixHash,
        };
      }
      return state;
    })

    // POST /v1/heartbeat — session heartbeat
    .post(
      "/heartbeat",
      async ({ body, user, device }) => {
        const [prevHb] = await db
          .select()
          .from(heartbeats)
          .where(eq(heartbeats.sessionId, body.sessionId))
          .limit(1);

        const [session] = await db
          .select({
            inTurn: sessions.inTurn,
            lastTs: sessions.lastTs,
            repoId: sessions.repoId,
          })
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

        if (session) {
          const newState = classifySessionState({
            heartbeatUpdatedAt: new Date(),
            inTurn: session.inTurn ?? false,
            lastTs: session.lastTs,
          });

          if (newState !== prevState && session.repoId) {
            const msg: SessionUpdatedMessage = {
              type: "session_updated",
              session_id: body.sessionId,
              user_id: user.id,
              github_login: user.githubLogin,
              repo_id: session.repoId,
              last_ts: session.lastTs?.toISOString(),
              state: newState,
            };
            await redis.publish(`repo:${session.repoId}`, msg);
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
      },
    );
