import { Elysia, t } from "elysia";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import {
  SOURCES,
  type CollisionDetectedMessage,
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
import { detectCollisions } from "../correlate/file-index";
import { config } from "../config";
import { makeSemaphore } from "../util/semaphore";

function topFilesKeys(field: unknown): string[] {
  if (!field || typeof field !== "object") return [];
  return Object.keys(field as Record<string, number>);
}

const ingestGate = makeSemaphore(config.ingestConcurrency);

export const ingestRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/v1", name: "ingest" })
    .use(apiKeyAuth)

    // POST /v1/ingest — upload NDJSON event chunk.
    //
    // The body is consumed as a stream so a large `fromLineSeq=0` resync never
    // sits as a single in-memory string. Lines are batched into ~200-row
    // inserts; `lastSafeAdvance` only moves on a successful batch flush so a
    // mid-stream failure returns a `serverLineSeq` the client can safely retry
    // from (idempotent via the `(session_id, line_seq)` unique key).
    .post(
      "/ingest",
      async ({ request, query, user, device }): Promise<IngestResponse> => {
        const release = await ingestGate();
        try {
          return await handleIngest(db, redis, request, query, user, device);
        } finally {
          release();
        }
      },
      {
        // Skip Elysia's default JSON parser — we read `request.body` as a
        // stream inside the handler. Returning the raw Request leaves the
        // body untouched.
        parse: "none",
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
            void redis.publish(`repo:${session.repoId}`, msg);
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

interface IngestQuery {
  project: string;
  session: string;
  fromLineSeq: string;
  prefixHash?: string;
  source?: EventSource;
}

interface AuthedUser {
  id: number;
  githubLogin: string;
}

interface AuthedDevice {
  id: number;
}

async function handleIngest(
  db: Database,
  redis: RedisBridge,
  request: Request,
  query: IngestQuery,
  user: AuthedUser,
  device: AuthedDevice | null | undefined,
): Promise<IngestResponse> {
  const source: EventSource = query.source ?? "claude";
  const fromLineSeq = Number(query.fromLineSeq);

  // Ensure the parent session row exists so the events FK is satisfied.
  // Use onConflictDoNothing so we don't clobber serverLineSeq mid-stream;
  // the final value is written once at the end.
  await db
    .insert(sessions)
    .values({
      sessionId: query.session,
      userId: user.id,
      deviceId: device?.id ?? null,
      source,
      project: query.project,
      serverLineSeq: fromLineSeq,
      prefixHash: query.prefixHash ?? null,
    })
    .onConflictDoNothing({ target: sessions.sessionId });

  const body = request.body;
  if (!body) {
    return { acceptedEvents: 0, duplicateEvents: 0, serverLineSeq: fromLineSeq };
  }

  let currentLineSeq = fromLineSeq;
  let acceptedEvents = 0;
  let attemptedRows = 0;

  const BATCH_SIZE = config.ingestBatchSize;
  let batch: Array<{ lineSeq: number; event: unknown }> = [];

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const rows = batch.map(({ lineSeq, event }) => {
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
      .onConflictDoNothing({ target: [events.sessionId, events.lineSeq] })
      .returning({ lineSeq: events.lineSeq });
    acceptedEvents += inserted.length;
    batch = [];
  };

  const consumeLine = (line: string): void => {
    if (line.trim().length > 0) {
      try {
        batch.push({ lineSeq: currentLineSeq, event: JSON.parse(line) });
        attemptedRows++;
      } catch {
        // Mid-flush partial JSON: drop the line but still consume its seq so
        // client and server stay aligned on retries.
      }
    }
    currentLineSeq++;
  };

  // We don't try to "save" partial progress on stream/insert errors. The
  // desktop uploader advances `byteOffset` by the bytes it sent and trusts
  // the returned `serverLineSeq` as a line counter — so returning a partial
  // seq on a 200 response would skip the unflushed lines on the next read
  // and permanently desync line_seq from file content. Let errors propagate
  // (Elysia returns 5xx); the client retries the same chunk and the unique
  // (session_id, line_seq) key dedups any batches that already committed.
  let totalLines = 0;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body as ReadableStream<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      totalLines++;
      consumeLine(line);
      if (batch.length >= BATCH_SIZE) await flushBatch();
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    totalLines++;
    consumeLine(pending);
  }
  await flushBatch();

  if (totalLines === 0) {
    return { acceptedEvents: 0, duplicateEvents: 0, serverLineSeq: fromLineSeq };
  }

  // Re-read the events to fold from Postgres rather than from an in-memory
  // accumulator built during streaming. The DB is the durable source of
  // truth: this picks up rows orphaned by an earlier failed retry (committed
  // by one batch flush, abandoned when a later batch threw) so they're
  // included in the aggregate exactly once on the next successful retry.
  // Without this, those rows would dedup-skip on retry and never reach
  // processEvents — silently dropping their contribution to userMsgs,
  // token counts, topFilesEdited, cwd/repoId resolution, etc.
  //
  // Lower bound = max(fromLineSeq, currentSession.serverLineSeq) so we don't
  // double-count events already folded by a concurrent ingest.
  const [currentSession] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, query.session))
    .limit(1);

  let priorFiles: string[] = [];
  let currentFiles: string[] = [];
  // Tracks whether *our* update wrote the row. The WHERE clause is a
  // compare-and-set on serverLineSeq, so a stale retry or a concurrent ingest
  // that already advanced past us silently no-ops here. We use this to (a)
  // never regress serverLineSeq/prefixHash, (b) skip WS notifications we
  // didn't earn — the race winner already published.
  let updateApplied = false;

  if (currentSession) {
    const aggregateFrom = Math.max(fromLineSeq, currentSession.serverLineSeq ?? 0);
    const eventsToFold =
      aggregateFrom < currentLineSeq
        ? await db
            .select({ payload: events.payload })
            .from(events)
            .where(
              and(
                eq(events.sessionId, query.session),
                gte(events.lineSeq, aggregateFrom),
                lt(events.lineSeq, currentLineSeq),
              ),
            )
            .orderBy(events.lineSeq)
        : [];

    priorFiles = [
      ...topFilesKeys(currentSession.topFilesEdited),
      ...topFilesKeys(currentSession.topFilesWritten),
    ];
    currentFiles = priorFiles;

    if (eventsToFold.length > 0) {
      const payloads = eventsToFold.map((e) => e.payload);
      const updates = processEvents(source, currentSession, payloads);
      currentFiles = [
        ...Object.keys(updates.topFilesEdited),
        ...Object.keys(updates.topFilesWritten),
      ];
      const result = await db
        .update(sessions)
        .set({
          ...updates,
          serverLineSeq: currentLineSeq,
          prefixHash: query.prefixHash ?? undefined,
        })
        .where(
          and(eq(sessions.sessionId, query.session), lt(sessions.serverLineSeq, currentLineSeq)),
        )
        .returning({ sessionId: sessions.sessionId });
      updateApplied = result.length > 0;

      // Retry while repo_id unresolved; fall back to the session's stored cwd
      // so strategy 3 (project-slug) can fire even when no event has ever
      // carried a cwd. The `isNull(repoId)` guard makes this a compare-and-set:
      // concurrent ingests for the same session can both reach this branch
      // with stale snapshots, but only the first writer's value sticks. Skip
      // when our main update lost the race — the winner ran the same logic.
      if (updateApplied && !currentSession.repoId) {
        const cwd = updates.cwd ?? currentSession.cwd ?? null;
        const repoId = await matchSessionRepo(db, user.id, cwd, query.project, device?.id);
        if (repoId) {
          await db
            .update(sessions)
            .set({ repoId })
            .where(and(eq(sessions.sessionId, query.session), isNull(sessions.repoId)));
        }
      }
    } else {
      // Stream advanced but nothing new to fold (all blanks, or already
      // covered by a concurrent ingest). Try to write the seq forward, but
      // only if it's actually moving forward — the CAS guard prevents a
      // stale retry from regressing serverLineSeq.
      const result = await db
        .update(sessions)
        .set({
          serverLineSeq: currentLineSeq,
          prefixHash: query.prefixHash ?? undefined,
        })
        .where(
          and(eq(sessions.sessionId, query.session), lt(sessions.serverLineSeq, currentLineSeq)),
        )
        .returning({ sessionId: sessions.sessionId });
      updateApplied = result.length > 0;
    }
  }

  // Notify on any update we actually applied — folding existing events still
  // changes the aggregate clients render, even when no rows were inserted in
  // this request (e.g. a retry that picks up rows orphaned by a previous
  // failed flush). Conversely, skip when our update lost the CAS race; the
  // winner has already published the more recent state.
  if (updateApplied) {
    const [finalSession] = await db
      .select({
        repoId: sessions.repoId,
        lastTs: sessions.lastTs,
      })
      .from(sessions)
      .where(eq(sessions.sessionId, query.session))
      .limit(1);

    // Only publish when we've resolved a repo — clients dedupe by receiving
    // exactly once via `repo:<id>`. The session owner's own cache is already
    // invalidated locally by `uploader.onIngested`, so we don't need a
    // user-channel echo.
    if (finalSession?.repoId) {
      const msg: SessionUpdatedMessage = {
        type: "session_updated",
        session_id: query.session,
        user_id: user.id,
        github_login: user.githubLogin,
        repo_id: finalSession.repoId,
        last_ts: finalSession.lastTs?.toISOString(),
      };
      void redis.publish(`repo:${finalSession.repoId}`, msg);

      const collisions = detectCollisions({
        repoId: finalSession.repoId,
        sessionId: query.session,
        userId: user.id,
        githubLogin: user.githubLogin,
        currentFiles,
        priorFiles,
      });
      for (const c of collisions) {
        const cmsg: CollisionDetectedMessage = {
          type: "collision_detected",
          repo_id: finalSession.repoId,
          file_path: c.filePath,
          ts: new Date().toISOString(),
          trigger: {
            sessionId: query.session,
            userId: user.id,
            githubLogin: user.githubLogin,
          },
          others: c.others,
        };
        void redis.publish(`repo:${finalSession.repoId}`, cmsg);
      }
    }
  }

  return {
    acceptedEvents,
    duplicateEvents: attemptedRows - acceptedEvents,
    serverLineSeq: currentLineSeq,
  };
}
