# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product intent

**Chat-heads-style presence for Claude Code sessions.** A rail of teammate avatars — people who share a GitHub repo with you; click one to peek into their live sessions: current prompt, files Claude is editing right now, latest tool results and token spend. Ambient awareness of what your team is building with Claude, plus a "Fork Session" action to branch off someone else's work.

The backend in this repo makes that possible: a CLI watcher on each device tails Claude Code's `~/.claude/projects/*/*.jsonl` event streams and POSTs NDJSON chunks; the server aggregates them, matches sessions to GitHub repos (social graph = repo co-membership), computes live/busy/idle state at read time, and fans updates out over WebSockets. Authoritative design in `specs/backend.spec.md` and `specs/upload.spec.md` — consult before changing API shape, auth, the event pipeline, or state classification.

The desktop/web UI that renders chat heads is not built yet (`apps/desktop` is an empty stub).

## Repo layout

Bun workspace monorepo:

- `apps/server` — ElysiaJS backend, the only real code today. Entry `src/index.ts` composes `githubAuth`, `ingestRoutes`, `socialRoutes`, `sessionRoutes`, `userRoutes`, `wsHandler`.
- `apps/desktop` — placeholder (`package.json` only).
- `packages/shared` — source-only TS types (`SessionSnapshot`, `SessionState`, `TokenUsage`, …). No build; consumers import via tsconfig `paths`.
- `specs/` — authoritative design docs; the code lags them materially (see "Implementation status").

## Commands

Bun is required. Workspace scripts run from the workspace dir:

```bash
bun install                    # from repo root, installs all workspaces

# in apps/server
bun run dev                    # watch-mode, src/index.ts
bun run start                  # one-shot
bun run typecheck              # tsc --noEmit
bun run db:generate            # drizzle-kit, after editing src/db/schema.ts
bun run db:migrate

# in packages/shared
bun run typecheck
```

`config.ts` throws at boot if any var in `.env.example` is unset; Postgres + Redis must be reachable. Default port 10000. No test runner is wired up — use `bun test` if adding tests.

## Architecture that matters

**Two auth plugins, mutually exclusive routes** (`src/auth/middleware.ts`):
- `jwtAuth` — httpOnly `session` cookie, browser routes (`/auth/*`, `/api/*`). Derives `{ user }`.
- `apiKeyAuth` — `Authorization: Bearer <key>`, SHA-256 compared to `api_keys.key_hash`, CLI routes (`/v1/*`). Derives `{ user, device }`.
- WS upgrade (`ws/handler.ts`) accepts either via `?token=...` — tries JWT first, then API key.

**Session state is computed, never stored** (`sessions/state.ts`). `classifySessionState({heartbeatUpdatedAt, inTurn, lastTs})` → `BUSY | ACTIVE | IDLE | RECENT | ENDED`. Thresholds: heartbeat fresh < 30s, active < 10s since last event, recent < 1h. `in_turn` is the *only* reliable signal during a silent thinking block (tens of seconds with zero JSONL events) — by design it flips on at user prompt / queued command and off at assistant `stop_reason == "end_turn"`. Don't collapse this to "just use lastTs"; `specs/upload.spec.md` "Busy is computed, not observed" calls this out.

**Ingest protocol is resumable** (`ingest/routes.ts`). CLI POSTs NDJSON to `/v1/ingest?session=…&fromOffset=…`; server dedups by `events.uuid` (`onConflictDoNothing`), persists `server_offset + prefix_hash` on the session, returns `{acceptedBytes, acceptedEvents, duplicateEvents, serverOffset}`. CLI uses `GET /v1/sync-state` on startup to learn where to resume each session. Don't change the dedup key or offset semantics without updating the CLI.

**Redis pub/sub → WebSocket fan-out** (`ws/redis-bridge.ts`, `ws/handler.ts`). Separate `pub`/`sub` ioredis clients (ioredis requirement). On WS open, subscribes the connection to `repo:<id>` for every row in `user_repos`, plus `user:<userId>`. `RedisBridge` is soft-fail: if Redis can't connect, `publish`/`subscribe` become no-ops and the HTTP API keeps working.

**Secrets** (`auth/tokens.ts`). GitHub OAuth tokens are AES-256-GCM encrypted (`hex(iv):hex(ciphertext)`) with `ENCRYPTION_KEY` before insert. Refresh tokens, API keys, and setup tokens are stored as SHA-256 hashes — plaintext returned exactly once at issuance. Never log or return the raw values.

**`@slashtalk/shared` is source-only.** No build, no `dist`. `apps/server/tsconfig.json` maps the package to `packages/shared/src` via `paths`. Keep runtime values (enums, constants) minimal here unless you're willing to add a build step — today it's mostly types, plus a `SessionState` object literal that works only because it's imported from TS source directly.

## Implementation status

The spec is substantially ahead of the code. The backend skeleton exists, but several load-bearing pieces are stubs — expect the feed and realtime UI to appear empty end-to-end until these are filled in:

- **Ingest does not update session aggregates.** `/v1/ingest` inserts raw events and bumps `server_offset`, but never updates `lastTs`, `tokensIn/Out/…`, `userMsgs`, `assistantMsgs`, `toolCalls`, `inTurn`, `recentEvents`, `topFiles*`, `lastUserPrompt`, etc. on the `sessions` row. Spec §5 describes event-by-event aggregation; it's not implemented.
- **`in_turn` is read but never written.** `classifySessionState` reads it; nothing sets it. Until ingest parses events, every session will classify as `ACTIVE`/`IDLE` (based on `lastTs`), never `BUSY`.
- **Nothing publishes to Redis.** No call to `redis.publish()` exists. WS clients connect and receive only the 30s ping — no `session_updated` messages.
- **Session → repo matching is absent.** `sessions.repo_id` is never set on insert, so `/api/feed` (`inArray(sessions.repoId, repoIds)`) always returns `[]`.
- **Repo sync is a TODO.** `POST /api/me/sync-repos` returns a stub. Nothing populates `repos` or `user_repos`, so the social graph is empty by default — which also means `/api/feed/users` always returns `[]`.
- **`install.sh` endpoint is missing.** Spec §1.2/§6 describe `GET /install.sh`; only the back half (`POST /auth/exchange`) exists.
- **`/api/feed/users` has N+1 queries.** Loops over peers issuing 3 queries each. Fine for demo; rework for real data.

When adding a feature, check whether its upstream dependency is one of the above before assuming the plumbing works end-to-end.

## Conventions

- Elysia plugins are factories `(db, redis?) => new Elysia({ name, prefix })`. The `name` is required for Elysia's plugin dedup — preserve it when editing.
- Route prefix encodes auth: `/v1/*` = API key (CLI), `/auth/*` + `/api/*` = JWT (web). Don't mix.
- Drizzle schema (`src/db/schema.ts`) is source of truth; regenerate migrations with `db:generate` after schema edits.
- TS is strict across the repo; all tsconfigs use `moduleResolution: bundler` and ESM (`"type": "module"`).

## Keeping this file in sync

**When you make an architectural change, update CLAUDE.md in the same commit.** Specifically: adding/removing a workspace, changing the auth model, changing the ingest protocol or event-dedup semantics, touching the Redis pub/sub channel design, closing or opening an "Implementation status" gap, adding a new top-level route prefix, or changing how `@slashtalk/shared` is consumed. If a change would invalidate a claim in this file, fix the claim — a subtly wrong CLAUDE.md is worse than a missing one.
