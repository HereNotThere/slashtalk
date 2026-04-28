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
import { extractCodexQuotaFromBatch, writeQuotaPresence } from "../presence/quota";
import type { QuotaPresence } from "@slashtalk/shared";

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
    // inserts. On any stream/insert error the handler throws (Elysia returns
    // 5xx); the client retries the same chunk and the unique `(session_id,
    // line_seq)` key dedups any batches that already committed. The
    // post-stream aggregate fold reads back from Postgres so rows orphaned by
    // an earlier failed retry are still picked up exactly once.
    .post(
      "/ingest",
      async ({ request, query, user, device, set }): Promise<IngestResponse | IngestError> => {
        const release = await ingestGate();
        try {
          return await handleIngest(db, redis, request, query, user, device, set);
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
          // Numeric: bare Number("abc") returned NaN and downstream Drizzle
          // comparisons silently failed open.
          fromLineSeq: t.Numeric({ minimum: 0 }),
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
      async ({ body, user, device, set }) => {
        // Authorize before doing anything: a device API key without this gate
        // could heartbeat any session whose UUID it knew, polluting another
        // user's `heartbeats` row and publishing a `session_updated` to the
        // repo channel under the attacker's `user_id`/`github_login` —
        // spoofing presence on the live feed.
        const [session] = await db
          .select({
            inTurn: sessions.inTurn,
            lastTs: sessions.lastTs,
            repoId: sessions.repoId,
          })
          .from(sessions)
          .where(and(eq(sessions.sessionId, body.sessionId), eq(sessions.userId, user.id)))
          .limit(1);

        if (!session) {
          set.status = 404;
          return { error: "session_not_found" };
        }

        const [prevHb] = await db
          .select()
          .from(heartbeats)
          .where(eq(heartbeats.sessionId, body.sessionId))
          .limit(1);

        const prevState = classifySessionState({
          heartbeatUpdatedAt: prevHb?.updatedAt ?? null,
          inTurn: session.inTurn ?? false,
          lastTs: session.lastTs,
        });

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
  fromLineSeq: number;
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

interface IngestError {
  error: string;
}

async function handleIngest(
  db: Database,
  redis: RedisBridge,
  request: Request,
  query: IngestQuery,
  user: AuthedUser,
  device: AuthedDevice | null | undefined,
  set: { status?: number | string },
): Promise<IngestResponse | IngestError> {
  const source: EventSource = query.source ?? "claude";
  const fromLineSeq = query.fromLineSeq;

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

  // Authorize: the row above either was just inserted (owned by us) or already
  // existed. Verify ownership before writing any events — without this, a
  // device API key could append events tagged with the caller's userId into
  // any session whose UUID they know, corrupting another user's transcript
  // and spoofing attribution on the live feed.
  const [owner] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.sessionId, query.session))
    .limit(1);
  if (!owner || owner.userId !== user.id) {
    set.status = 403;
    return { error: "session_not_owned" };
  }

  const body = request.body;
  if (!body) {
    return { acceptedEvents: 0, duplicateEvents: 0, serverLineSeq: fromLineSeq };
  }

  let currentLineSeq = fromLineSeq;
  let acceptedEvents = 0;
  let attemptedRows = 0;
  // Track the freshest Codex quota seen across all batches in this ingest. We
  // do one Redis write after the stream finishes rather than per-batch — most
  // batches won't contain a token_count event, and `extractCodexQuotaFromBatch`
  // already takes the latest within a single batch, so chaining the latest
  // across batches preserves "freshest wins" with one round-trip.
  let latestCodexQuota: QuotaPresence | null = null;

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

    // Pluck the latest Codex rate-limit signal out of *every* row the client
    // sent over the wire — not just the ones that just inserted. A retry
    // after a partial commit re-streams the same chunk; `onConflictDoNothing`
    // returns zero rows for batches that already committed, so filtering by
    // `inserted` would drop a token_count event that happens to land on a
    // duplicate line_seq and silently lose the quota update across the
    // failure boundary. The wire payload is authoritative regardless of
    // whether the row pre-existed; Redis writes are idempotent so picking up
    // the same quota twice is harmless.
    if (source === "codex") {
      const q = extractCodexQuotaFromBatch(batch.map((b) => b.event));
      if (q) latestCodexQuota = q;
    }

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
  // The same dedup-on-retry property is what makes the byte/deadline early
  // returns below safe — anything we already flushed is idempotent.
  let totalLines = 0;
  let totalBytes = 0;
  const decoder = new TextDecoder();
  let pending = "";
  const startedAtMs = Date.now();
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  // The total-bytes cap doesn't bound `pending` if the attacker sends bytes
  // without a newline, so put a separate (tighter) cap on a single staged
  // line. A real session event is at most a few KB.
  const maxPending = Math.min(config.ingestMaxBytes, 1024 * 1024);
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      totalBytes += chunk.byteLength;
      if (totalBytes > config.ingestMaxBytes) {
        void reader.cancel().catch(() => undefined);
        set.status = 413;
        return { error: "payload_too_large" };
      }
      if (Date.now() - startedAtMs > config.ingestDeadlineMs) {
        void reader.cancel().catch(() => undefined);
        set.status = 408;
        return { error: "ingest_deadline_exceeded" };
      }
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > maxPending) {
        void reader.cancel().catch(() => undefined);
        set.status = 413;
        return { error: "line_too_large" };
      }
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        totalLines++;
        consumeLine(line);
        if (batch.length >= BATCH_SIZE) await flushBatch();
      }
    }
  } finally {
    reader.releaseLock();
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    totalLines++;
    consumeLine(pending);
  }
  await flushBatch();

  // One Redis write per ingest with whichever quota was freshest across all
  // batches. Soft-fail inside writeQuotaPresence — a Redis blip must never
  // break ingest itself.
  if (latestCodexQuota) {
    await writeQuotaPresence(redis, user.id, latestCodexQuota);
  }

  if (totalLines === 0) {
    return { acceptedEvents: 0, duplicateEvents: 0, serverLineSeq: fromLineSeq };
  }

  // Re-read the events to fold from Postgres rather than from an in-memory
  // accumulator built during streaming. The DB is the durable source of
  // truth: this picks up rows orphaned by an earlier failed retry (committed
  // by one batch flush, abandoned when a later batch threw) so they're
  // included in the aggregate exactly once on the next successful retry.
  //
  // Range = [currentSession.serverLineSeq, currentLineSeq). The lower bound
  // is the actual aggregate boundary on the session row, NOT the client's
  // fromLineSeq. Two concurrent ingests with disjoint fromLineSeq ranges
  // (T1 sends [100,150), T2 sends [150,200)) both read the same baseline
  // pre-update; if we used max(fromLineSeq, ...) here, T2's fold would
  // start at 150 and miss T1's events 100–149 entirely after T1's update
  // is overwritten. Reading from the DB-stored aggregate boundary makes
  // the fold range self-correcting under races — whichever request wins
  // the CAS includes everything since the last committed aggregate.
  const [currentSession] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, query.session))
    .limit(1);

  let priorFiles: string[] = [];
  let currentFiles: string[] = [];
  // Tracks whether *our* update wrote the aggregate row. The WHERE clause
  // is a compare-and-set on serverLineSeq, so a stale retry or a concurrent
  // ingest that already advanced past us silently no-ops here. We use this
  // to (a) never regress serverLineSeq/prefixHash, (b) skip WS notifications
  // we didn't earn — the race winner already published. Pure watermark
  // bumps (no aggregate change) intentionally do NOT set this true.
  let updateApplied = false;

  if (currentSession) {
    const aggregateFrom = currentSession.serverLineSeq ?? 0;

    priorFiles = [
      ...topFilesKeys(currentSession.topFilesEdited),
      ...topFilesKeys(currentSession.topFilesWritten),
    ];
    currentFiles = priorFiles;

    // Page through the fold range so a large resync doesn't load every
    // event payload at once — that's the OOM the streaming refactor was
    // trying to prevent. Each page is fed to processEvents and the result
    // is chained as the next page's baseline. processEvents' `topN` clip
    // means files that rank below the cutoff in early pages but climb in
    // later pages may rank slightly off, but token counts, msg counts and
    // tool-call counts are additive so they stay accurate.
    let workingState: typeof currentSession = currentSession;
    let updates: ReturnType<typeof processEvents> | null = null;
    let foldedAny = false;
    let cursor = aggregateFrom;

    while (cursor < currentLineSeq) {
      const page = await db
        .select({ lineSeq: events.lineSeq, payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.sessionId, query.session),
            gte(events.lineSeq, cursor),
            lt(events.lineSeq, currentLineSeq),
          ),
        )
        .orderBy(events.lineSeq)
        .limit(BATCH_SIZE);
      if (page.length === 0) break;
      foldedAny = true;
      const payloads = page.map((e) => e.payload);
      updates = processEvents(source, workingState, payloads);
      workingState = { ...workingState, ...updates } as typeof currentSession;
      cursor = page[page.length - 1]!.lineSeq + 1;
    }

    if (foldedAny && updates) {
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
    }

    if (!updateApplied) {
      // Either the fold range was empty (all-blank/all-malformed body, or
      // already covered by a concurrent ingest) or our aggregate update lost
      // the CAS race. Either way, no aggregate field changed — only the
      // watermark might still need to advance. Try a CAS-guarded watermark
      // update but DON'T touch updateApplied: clients render aggregates,
      // not serverLineSeq, so a pure watermark bump isn't worth the
      // session_updated fan-out across the repo channel.
      await db
        .update(sessions)
        .set({
          serverLineSeq: currentLineSeq,
          prefixHash: query.prefixHash ?? undefined,
        })
        .where(
          and(eq(sessions.sessionId, query.session), lt(sessions.serverLineSeq, currentLineSeq)),
        );
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
