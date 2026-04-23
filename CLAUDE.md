# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product intent

**Chat-heads-style presence for Claude Code sessions.** A rail of teammate avatars — people who share a GitHub repo with you; click one to peek into their live sessions: current prompt, files Claude is editing right now, latest tool results and token spend. Ambient awareness of what your team is building with Claude, plus a "Fork Session" action to branch off someone else's work.

The backend in this repo makes that possible: a CLI watcher on each device tails Claude Code's `~/.claude/projects/*/*.jsonl` event streams and POSTs NDJSON chunks; the server aggregates them, matches sessions to GitHub repos (social graph = repo co-membership), computes live/busy/idle state at read time, and fans updates out over WebSockets. Authoritative design in `specs/backend.spec.md` and `specs/upload.spec.md` — consult before changing API shape, auth, the event pipeline, or state classification.

The desktop UI shell (`apps/desktop`) exists — Electron + React + Tailwind v4, floating overlay/tray windows — but only the backend sign-in and "add local repo" flow is wired to the server. The teammate rail, live session peek, and Fork Session are not built.

## Repo layout

Bun workspace monorepo:

- `apps/server` — ElysiaJS backend. Entry `src/index.ts` composes `githubAuth`, `cliAuth`, `ingestRoutes`, `socialRoutes`, `sessionRoutes`, `userRoutes`, `deviceReposRoutes`, `wsHandler`.
- `apps/desktop` — Electron app (`@slashtalk/electron`), tailwind v4, 4 BrowserWindows (main/overlay/info/statusbar). Talks to the backend via an HTTP client in `src/main/backend.ts` plus IPC to renderers. Sign-in opens the system browser to `${BACKEND}/auth/github?desktop_port=NNNN` and receives the callback on a loopback listener on port NNNN.
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

`config.ts` throws at boot if any var in `.env.example` is unset; Postgres + Redis must be reachable. Default port 10000. The server has a `bun test` suite under `apps/server/test/` (classifier, ingest, refresh, pr-poller, integration) — run via `bun run test` from `apps/server`. The desktop app has no test runner wired up.

## Architecture that matters

**Two auth plugins, mutually exclusive routes** (`src/auth/middleware.ts`):
- `jwtAuth` — httpOnly `session` cookie (or raw JWT in the `Cookie` header from the desktop app), browser routes (`/auth/*`, `/api/*`). Derives `{ user }`.
- `apiKeyAuth` — `Authorization: Bearer <key>`, SHA-256 compared to `api_keys.key_hash`, CLI routes (`/v1/*`). Derives `{ user, device }`.
- WS upgrade (`ws/handler.ts`) accepts either via `?token=...` — tries JWT first, then API key.

**OAuth is read-only / identity-only.** `/auth/github` requests **`read:user read:org` only** — no `repo` scope. That means we **cannot** call `/user/repos` or read private repo contents server-side. Instead, repos are **claimed** on demand: the desktop app reads a local clone's `.git/config`, extracts `owner/name`, and calls `POST /api/me/repos { fullName }` which upserts the `repos` row (by unique `full_name`) and the `user_repos` tracking row. The user proves repo possession by being able to clone it locally — GitHub already gated access at clone time. `repos.github_id` is therefore nullable; if you ever add a code path that can fetch it, backfill it, don't treat its absence as a bug. The old `syncUserRepos` / `POST /api/me/sync-repos` are gone.

**Desktop auth flow** — the Electron app is both a JWT session holder and a registered device. On sign-in it: (1) opens the browser to `${BACKEND}/auth/github?desktop_port=NNNN`, (2) `/auth/github/callback` redirects to `http://127.0.0.1:NNNN/callback?jwt=…&refreshToken=…&login=…` instead of setting cookies, (3) desktop calls `POST /api/me/setup-token` then `POST /v1/auth/exchange` to get a device API key. JWT is sent to `/api/me/*` as a `Cookie: session=…` header from main; API key is sent to `/v1/devices/:id/repos`. Both live in `safeStorage`.

**Devices dedupe per (user, deviceName).** `/v1/auth/exchange` upserts on that pair (unique index added in migration `0003`) and revokes prior API keys for the reused device. So repeated sign-ins on the same laptop reuse the device row — `device_repo_paths`, `deviceExcludedRepos`, and historical `sessions.device_id` survive sign-out/in cycles. On sign-in (and at cold start if creds exist), the desktop calls `GET /v1/devices/:id/repos` and adopts the server's list as its tracked repos; the local `trackedRepos` store is still wiped on sign-out, so the server is the recovery source.

**Session state is computed, never stored** (`sessions/state.ts`). `classifySessionState({heartbeatUpdatedAt, inTurn, lastTs})` → `BUSY | ACTIVE | IDLE | RECENT | ENDED`. Thresholds: heartbeat fresh < 30s, active < 10s since last event, recent < 1h. `in_turn` is the *only* reliable signal during a silent thinking block (tens of seconds with zero JSONL events) — by design it flips on at user prompt / queued command and off at assistant `stop_reason == "end_turn"`. Don't collapse this to "just use lastTs"; `specs/upload.spec.md` "Busy is computed, not observed" calls this out.

**Ingest protocol is resumable** (`ingest/routes.ts`). Client POSTs NDJSON to `/v1/ingest?session=…&project=…&fromLineSeq=N&prefixHash=…`; server dedups by `(session_id, line_seq)` (`onConflictDoNothing`), persists `server_line_seq + prefix_hash` on the session, returns `{acceptedEvents, duplicateEvents, serverLineSeq}`. Line-seq counts every newline-delimited chunk in the source file (including blank/malformed lines) so client and server stay aligned even when individual lines are dropped. Client uses `GET /v1/sync-state` on startup to learn where to resume each session. Don't change the dedup key or seq semantics without updating the Electron uploader.

**Desktop owns the CLI-watcher pipeline.** `apps/desktop/src/main/uploader.ts` tails `~/.claude/projects/*/*.jsonl` via `fs.watch(..., {recursive: true})` and ships deltas to `/v1/ingest`; `heartbeat.ts` watches `~/.claude/sessions/` and posts `/v1/heartbeat` every 15s plus on change for any pid-live session. Both run whenever the desktop is signed in and stop on sign-out. **Strict tracking:** a session's first-line `cwd` must resolve under a tracked local repo path (`localRepos.list()`) or it is never uploaded or heartbeated. The server-side `install.sh` / `GET /install.sh` still exist but are deprecated and byte-offset-based against the old ingest API — do not extend them; the desktop app is the supported client.

**Redis pub/sub → WebSocket fan-out** (`ws/redis-bridge.ts`, `ws/handler.ts`). Separate `pub`/`sub` ioredis clients (ioredis requirement). On WS open, subscribes the connection to `repo:<id>` for every row in `user_repos`, plus `user:<userId>`. `RedisBridge` is soft-fail: if Redis can't connect, `publish`/`subscribe` become no-ops and the HTTP API keeps working.

**PR activity is the only Redis publisher today** (`social/pr-poller.ts`). Polls `https://api.github.com/users/:login/events` every 60s for every user with a stored token, filters `PullRequestEvent` (action `opened`/`reopened`, or `closed && merged`), looks up the matching `repos` row by `full_name`, and publishes a `PrActivityMessage` (see `@slashtalk/shared`) to `repo:<id>`. Per-user `lastSeenEventId` is in-memory — a process restart re-baselines from each user's feed head rather than replaying history. The desktop's `main/ws.ts` consumes these and calls `rail.markPrActivity(login)`, which the overlay renders as a celebratory ring/spark animation around the actor's chat head. WS clients should expect `{ type: "pr_activity" }` plus the existing `{ type: "ping" }` keepalive — anything else is forward-compat noise.

**Secrets** (`auth/tokens.ts`). GitHub OAuth tokens are AES-256-GCM encrypted (`hex(iv):hex(ciphertext)`) with `ENCRYPTION_KEY` before insert. Refresh tokens, API keys, and setup tokens are stored as SHA-256 hashes — plaintext returned exactly once at issuance. Never log or return the raw values.

**`@slashtalk/shared` is source-only.** No build, no `dist`. `apps/server/tsconfig.json` maps the package to `packages/shared/src` via `paths`. Keep runtime values (enums, constants) minimal here unless you're willing to add a build step — today it's mostly types, plus a `SessionState` object literal that works only because it's imported from TS source directly.

## Implementation status

The spec is substantially ahead of the code. The backend skeleton exists, but several load-bearing pieces are stubs — expect the feed and realtime UI to appear empty end-to-end until these are filled in:

- **Ingest does not update session aggregates.** `/v1/ingest` inserts raw events and bumps `server_offset`, but never updates `lastTs`, `tokensIn/Out/…`, `userMsgs`, `assistantMsgs`, `toolCalls`, `inTurn`, `recentEvents`, `topFiles*`, `lastUserPrompt`, etc. on the `sessions` row. Spec §5 describes event-by-event aggregation; it's not implemented.
- **`in_turn` is read but never written.** `classifySessionState` reads it; nothing sets it. Until ingest parses events, every session will classify as `ACTIVE`/`IDLE` (based on `lastTs`), never `BUSY`.
- **Nothing session-related publishes to Redis.** The PR poller publishes `pr_activity` to `repo:<id>` (see "PR activity is the only Redis publisher today" above), but no call to `redis.publish()` exists for `session_updated`. Until ingest aggregation lands, presence/turn changes never fan out.
- **Session → repo matching is absent.** `sessions.repo_id` is never set on insert, so `/api/feed` (`inArray(sessions.repoId, repoIds)`) always returns `[]`.
- **Repo population path is the desktop app's "Add local repo" button** (`POST /api/me/repos`) — no auto-sync, by design. Social graph stays empty until a user claims a repo; `/api/feed/users` reflects only those claims.
- **`install.sh` is vestigial.** `GET /install.sh` serves it and `POST /v1/auth/exchange` still works, but the script posts byte-offset `fromOffset` against an API that now takes `fromLineSeq` — running it will 400. The desktop app is the supported watcher; delete the script when nothing else points at it.
- **`/api/feed/users` has N+1 queries.** Loops over peers issuing 3 queries each. Fine for demo; rework for real data.

When adding a feature, check whether its upstream dependency is one of the above before assuming the plumbing works end-to-end.

## Conventions

- Elysia plugins are factories `(db, redis?) => new Elysia({ name, prefix })`. The `name` is required for Elysia's plugin dedup — preserve it when editing.
- Route prefix encodes auth: `/v1/*` = API key (CLI), `/auth/*` + `/api/*` = JWT (web). Don't mix.
- Drizzle schema (`src/db/schema.ts`) is source of truth; regenerate migrations with `db:generate` after schema edits.
- TS is strict across the repo; all tsconfigs use `moduleResolution: bundler` and ESM (`"type": "module"`).

## Keeping this file in sync

**When you make an architectural change, update CLAUDE.md in the same commit.** Specifically: adding/removing a workspace, changing the auth model, changing the ingest protocol or event-dedup semantics, touching the Redis pub/sub channel design, closing or opening an "Implementation status" gap, adding a new top-level route prefix, or changing how `@slashtalk/shared` is consumed. If a change would invalidate a claim in this file, fix the claim — a subtly wrong CLAUDE.md is worse than a missing one.
