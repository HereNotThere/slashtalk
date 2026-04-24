# Reliability

How the load-bearing flows (ingest, heartbeat, pub/sub, analyzers) degrade and recover.

## Ingest resume protocol

**Contract.** The desktop uploader POSTs NDJSON to `POST /v1/ingest?session=&project=&fromLineSeq=N&prefixHash=`. The server:

1. Parses each `\n`-delimited JSON line, counting every line (including blanks/malformed) against `lineSeq` so client and server stay aligned on partial retries.
2. Upserts the `sessions` row.
3. Classifies each event (`apps/server/src/ingest/classifier.ts`).
4. Bulk-inserts into `events` with `ON CONFLICT (session_id, line_seq) DO NOTHING` — dedup is the primary-key constraint.
5. Aggregates (Claude only) via `processEvents()` (`apps/server/src/ingest/aggregator.ts`).
6. Attempts repo match if `sessions.repo_id` is still null.
7. Publishes `session_updated` to `repo:<id>` if any new events were accepted.

**Dedup key.** `(session_id, line_seq)`. The `prefixHash` (SHA-256 of the first 4KiB of the source file) is stored but does not currently gate reads; the desktop uploader uses it to detect file-truncation and reset offset to 0 when it differs.

**Resume on client restart.** `apps/desktop/src/main/uploader.ts` persists `{byteOffset, lineSeq, prefixHash, size, mtimeMs, tracked}` per session under Electron `userData/uploaderSyncState`. On startup the `tracked` flag is reset to `null` so repo-claim changes during the outage are re-evaluated; offsets are preserved.

**Recovery from loss.** `GET /v1/sync-state` returns `{ "<sessionId>": { serverLineSeq, prefixHash } }` so a fresh uploader can bootstrap without replaying from offset 0 on every file.

**Known gap.** No explicit rollback on partial upload. If the server accepts N lines then the client crashes before persisting the new `byteOffset`, the next startup resends those lines — the `ON CONFLICT DO NOTHING` dedup absorbs the duplicates, so behavior is correct but noisy.

## Heartbeat + state machine

**Contract.** `POST /v1/heartbeat` upserts the `heartbeats` row (`session_id`, `user_id`, `device_id`, `pid`, `kind`, `updated_at = now()`), classifies state before and after, and publishes `session_updated` only on state transitions.

**Desktop loop.** `apps/desktop/src/main/heartbeat.ts` runs every 15 s and on `fs.watch` events against `~/.claude/sessions/*.json`. It posts a heartbeat for each session whose `pid` is alive (`process.kill(pid, 0)` returns without `ESRCH`). Codex sessions are gated on `mtimeMs` within 10 minutes.

**State classification** (`apps/server/src/sessions/state.ts`):

| State | Condition |
| --- | --- |
| `BUSY` | heartbeat < 30 s old **and** `sessions.in_turn = true` |
| `ACTIVE` | heartbeat < 30 s old **and** last event < 30 s old |
| `IDLE` | heartbeat < 30 s old **and** last event ≥ 30 s old |
| `RECENT` | heartbeat ≥ 30 s old **and** last event < 1 h old |
| `ENDED` | otherwise |

**Why `in_turn` is load-bearing.** A silent thinking block can run for tens of seconds with zero JSONL events. `in_turn` flips `true` on every real user prompt or queued command, and `false` only on an assistant event with `stop_reason == "end_turn"`. Classifying solely by "time since last event" loses the BUSY state during thinking. Do not collapse.

**Known gap.** Heartbeat has no backoff when the server is down; 15-second spam continues until the server returns. Tier 4 of the harness plan adds a cheap structured-log channel; a circuit-breaker is tracked in `docs/exec-plans/tech-debt-tracker.md`.

## Redis pub/sub soft-fail

**Contract.** `apps/server/src/ws/redis-bridge.ts` exposes `publish`/`subscribe` that no-op if the `ioredis` clients are disconnected. Every caller is allowed to assume `publish` never throws.

**Clients.** Separate `pub` + `sub` ioredis connections (subscriber-mode is stateful). On WS open, `apps/server/src/ws/handler.ts` subscribes to `repo:<id>` for every row in `user_repos` plus `user:<userId>`.

**Channels in production.**

| Channel | Message types | Publisher |
| --- | --- | --- |
| `repo:<id>` | `session_updated` | ingest + heartbeat |
| `repo:<id>` | `session_insights_updated` | analyzer scheduler |
| `repo:<id>` | `pr_activity` | PR poller |
| `user:<userId>` | `presence` (Spotify now-playing) | `presence/routes.ts` |

**Liveness.** Server sends `{ type: "ping" }` every 30 s on every WS connection (Render's load balancer requires <60 s idle).

**Known gap.** WS clients ignore dropped messages — if a WebSocket reconnects after a `session_updated` was published during the gap, the client doesn't learn about it until the next message on the same channel. Mitigation: `/api/feed` is the source of truth; clients use WS as an invalidation signal, not state transport.

## Analyzer scheduler

**Contract.** `apps/server/src/analyzers/scheduler.ts` runs every `ANALYZER_TICK_MS` (default 300 s) when `ANTHROPIC_API_KEY` is set. Each tick:

1. Picks up to `ANALYZER_MAX_SESSIONS_PER_TICK` (default 200) sessions touched in the last hour or never analyzed.
2. Runs each registered analyzer's `shouldRun(ctx)` gate (line-seq delta + min-time).
3. Executes `run(ctx)` through a worker pool of size `ANALYZER_CONCURRENCY` (default 5).
4. On success, upserts into `session_insights` and publishes `session_insights_updated` on `repo:<id>`.
5. On error, preserves prior output/tokens/cost; updates only `analyzed_at + error_text`.

**In-process guard.** `tickInFlight` boolean — prevents overlapping ticks on a single replica.

**Known gap.** No distributed lock — multi-replica deployments will double-work. Tier 4 of the harness plan adds a Redis `SET NX EX` tick lock.

**Known gap.** No retries on `llm.ts` — a transient 429 or 5xx fails the analyzer run for that session until the next tick. Tier 4 adds exponential backoff + jitter with transient/permanent classification.

## Desktop watcher pipeline

**Uploader.** `fs.watch(~/.claude/projects, {recursive:true})` with 150 ms per-file debounce; state persisted every 500 ms; concurrency cap of 16 concurrent syncs (macOS fd limits). Strict-tracking gate applied per session before any network call.

**Heartbeat.** `fs.watch(~/.claude/sessions)` + `fs.watch(~/.codex/sessions)` with 250 ms debounce; 15 s fallback interval.

**Cred storage.** Both JWT and API key live in Electron `safeStorage` (Keychain / DPAPI / libsecret). JWT refresh in `apps/desktop/src/main/backend.ts` is single-flight — concurrent 401s share one `/auth/refresh` call.

## Secrets in the loop

See [`SECURITY.md`](SECURITY.md) for the threat model. Relevant here: a Redis outage that drops a `session_updated` does not leak any secret, because the channel's payload contains only identifiers, not session content. Session content is fetched per-request via `/api/feed` and `/api/session/:id` under `jwtAuth`.
