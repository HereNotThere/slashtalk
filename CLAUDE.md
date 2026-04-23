# CLAUDE.md

Guidance for Claude Code working in this repo. Read top-to-bottom before changing anything load-bearing. The "How to add X" recipes near the end are the fastest path to a correct first patch for common features.

## Product intent

**Chat-heads-style presence for Claude Code sessions.** A floating rail of teammate avatars — people who share a GitHub repo with you. Hover to peek into their live sessions: recent prompt/title, summaries, files being touched, tool activity, token spend, and current state. Ambient awareness of what your team is building with Claude, plus PR activity rings around the actor's chat head. "Fork Session" is still only an intended future CTA.

The current implementation is split between a backend and an Electron desktop app:

- The desktop app signs users in with GitHub, lets them claim local repos, tails Claude Code's `~/.claude/projects/*/*.jsonl` event streams, heartbeats live sessions from `~/.claude/sessions/*.json`, renders the teammate rail, and shows a live session info card.
- The backend ingests NDJSON event chunks, aggregates Claude session state, matches sessions back to claimed repos, computes `busy/active/idle/recent/ended` state at read time, runs LLM analyzers for summary fields, and fans PR/session/insight updates out over WebSockets.

Authoritative design lives in `specs/backend.spec.md` and `specs/upload.spec.md`. The spec is sometimes ahead of the code; verify both before changing API shape, auth, ingest semantics, or session-state classification, and update both code and `CLAUDE.md` when you close a gap.

## Repo layout

Bun workspace monorepo (`bun` is required; do not use npm/pnpm/yarn).

- `apps/server` — ElysiaJS backend. Entry `src/index.ts` boots `RedisBridge`, calls `createApp(db, redis)` (`src/app.ts` composes `githubAuth`, `cliAuth`, `ingestRoutes`, `socialRoutes`, `sessionRoutes`, `userRoutes`, `deviceReposRoutes`, `wsHandler`), then starts the PR poller and analyzer scheduler.
- `apps/desktop` — Electron app (`@slashtalk/electron`), React + Tailwind v4, with BrowserWindows for `main`, `overlay` (rail pill), `info` (session peek popover), `chat` (input pill), `response` (full-window viewer), `trayPopup`/status UI, plus the drag ghost `dockPlaceholder`. Talks to backend over HTTP via `src/main/backend.ts` and to renderers via IPC.
- `packages/shared` — source-only TS types/constants (`SessionSnapshot`, `FeedSessionSnapshot`, `SessionState`, `TokenUsage`, `PrActivityMessage`, `SOURCES`, `EVENT_KINDS`, ...). No build, no `dist`. Consumers import via tsconfig `paths`.
- `specs/` — `backend.spec.md` and `upload.spec.md` are the design docs. `todo.md` is aspirational, not authoritative.
- `.github/workflows/ci.yml` — CI runs typecheck + tests for `apps/server` against ephemeral Postgres 16 + Redis 7 services on every PR and push to `main`.

## Commands

```bash
# Repo root
bun install                    # installs all workspaces

# apps/server
bun run dev                    # watch-mode, src/index.ts
bun run start                  # one-shot
bun run typecheck              # tsc --noEmit
bun run test                   # bun test, runs everything under test/
bun run test test/upload.test.ts   # run a single file
bun run db:generate            # drizzle-kit; run after editing src/db/schema.ts
bun run db:migrate             # apply pending migrations to $DATABASE_URL

# apps/desktop
bun run dev                    # electron-vite dev (HMR all renderers + main)
bun run build                  # electron-vite build -> out/
bun run dist:mac               # build + electron-builder -> dist/*.dmg
bun run typecheck              # both tsconfig.node.json and tsconfig.web.json
bun run test                   # bun test (desktop coverage is minimal today)
bun run lint                   # eslint

# packages/shared
bun run typecheck
```

**Run tests often.** After any change in `apps/server/src/`, run `bun run typecheck && bun run test` from `apps/server` before reporting the task done. These are fast and cover the ingest pipeline, classifier, refresh flow, PR poller, and end-to-end session lifecycle. CI runs the same commands on every push; do not leave server typecheck red. For schema or aggregator changes, prefer `test/integration.test.ts` and `test/upload.test.ts` first since they exercise the most plumbing.

`apps/server/src/config.ts` throws at boot if any required env var is unset. Required: `DATABASE_URL`, `REDIS_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY`, `BASE_URL`. Optional: `PORT` (`10000`), `ANTHROPIC_API_KEY` (analyzer scheduler is disabled if unset), `ANALYZER_TICK_MS` (`300000`), `ANALYZER_MAX_SESSIONS_PER_TICK` (`200`), `ANALYZER_CONCURRENCY` (`5`).

## Architecture that matters

### Auth — two plugins, mutually exclusive routes (`src/auth/middleware.ts`)

- `jwtAuth` — httpOnly `session` cookie, browser routes (`/auth/*`, `/api/*`). Derives `{ user }`.
- `apiKeyAuth` — `Authorization: Bearer <key>`, SHA-256 compared to `api_keys.key_hash`, CLI/desktop routes (`/v1/*`). Derives `{ user, device }`.
- WS upgrade (`ws/handler.ts`) accepts either via `?token=...` and tries JWT first, then API key.

**Route prefix encodes auth.** `/v1/*` = API key. `/auth/*` + `/api/*` = JWT. Do not mix; if you need a new auth scheme, add a third plugin rather than overloading either.

### OAuth is identity-only

`/auth/github` requests `read:user read:org` only — no `repo` scope. We cannot call `/user/repos` or read repo contents server-side. Repos are **claimed** on demand: the desktop app reads a local clone's `.git/config`, extracts `owner/name`, and POSTs `/api/me/repos { fullName }`. The user proves possession by being able to clone it; GitHub already gated access at clone time. `repos.github_id` is therefore nullable; do not treat its absence as a bug. The old `syncUserRepos` / `POST /api/me/sync-repos` path is gone.

### Desktop auth flow

On sign-in:

1. The app opens the browser to `${BACKEND}/auth/github?desktop_port=NNNN` (loopback port chosen by OS).
2. `/auth/github/callback` redirects to `http://127.0.0.1:NNNN/callback?jwt=…&refreshToken=…&login=…` instead of setting cookies.
3. The desktop calls `POST /api/me/setup-token` with the JWT.
4. The desktop calls `POST /v1/auth/exchange` with the setup token to get `{ apiKey, deviceId }`.

Both credential sets live in Electron `safeStorage` (Keychain/DPAPI/libsecret). JWT goes to `/api/*` as `Cookie: session=…`; API key goes to `/v1/*` as `Authorization: Bearer …`. JWT refresh in `apps/desktop/src/main/backend.ts` is single-flight, so concurrent 401s share one `/auth/refresh` call.

### Devices dedupe per `(userId, deviceName)`

`/v1/auth/exchange` upserts on that pair (unique index from migration `0003`) and revokes prior API keys for the reused device. Repeated sign-ins on the same laptop reuse the device row, so `device_repo_paths`, `device_excluded_repos`, and historical `sessions.device_id` survive sign-out/in cycles. On sign-in, and on cold start if creds already exist, the desktop calls `GET /v1/devices/:id/repos` and adopts the server's list as its tracked repos.

### Session state is computed, never stored (`sessions/state.ts`)

`classifySessionState({ heartbeatUpdatedAt, inTurn, lastTs })` returns `BUSY | ACTIVE | IDLE | RECENT | ENDED`. Thresholds: heartbeat fresh `< 30s`, active `< 10s` since last event, recent `< 1h`.

**`in_turn` is the only reliable BUSY signal during a silent thinking block.** It flips on at real user prompts or queued commands and off at assistant `stop_reason == "end_turn"`. Do not collapse this to "just use lastTs"; `specs/upload.spec.md` calls out that busy is computed, not directly observed.

### Ingest is line-seq based and aggregating (`ingest/routes.ts`, `ingest/aggregator.ts`)

Client POSTs NDJSON to `/v1/ingest?session=…&project=…&fromLineSeq=N&prefixHash=…&source=claude|codex`. The handler:

1. Parses chunks. Blank or malformed lines still consume a line-seq slot so client/server remain aligned.
2. Upserts the `sessions` row.
3. Classifies events (`ingest/classifier.ts` -> `kind`, `turnId`, `callId`, `eventId`, `parentId`).
4. Bulk-inserts `events` with `ON CONFLICT (session_id, line_seq) DO NOTHING` for dedup.
5. Aggregates accepted Claude events via `processEvents()` into `lastTs`, token counters, message counts, `inTurn`, `outstandingTools`, `topFilesRead/Edited/Written`, `toolUseNames`, `queued`, `recentEvents`, `lastUserPrompt`, and metadata (`cwd`, `branch`, `model`, `version`, `title`).
6. Matches `sessions.repo_id` via `matchSessionRepo()` if it is still unset.
7. Publishes `{ type: "session_updated", session_id, repo_id, ... }` to `repo:<id>` when the session has a repo and ingest accepted events.

`POST /v1/heartbeat` upserts the `heartbeats` row, classifies state before/after, and publishes `session_updated` only when visible state changes.

`GET /v1/sync-state` exists server-side, but the current desktop uploader does **not** call it on startup; uploader resume currently uses the desktop's own persisted local state.

**Don't change the dedup key or line-seq semantics without updating `apps/desktop/src/main/uploader.ts` in the same commit.**

### Desktop owns the watcher pipeline

- `apps/desktop/src/main/uploader.ts` watches `~/.claude/projects` recursively, debounces per file, and ships deltas to `/v1/ingest`. It persists `{ byteOffset, lineSeq, prefixHash, size, mtimeMs, tracked }` per session, with concurrency capped at 16.
- `apps/desktop/src/main/heartbeat.ts` watches `~/.claude/sessions/*.json`, and every 15s plus on change posts `/v1/heartbeat` for every session whose `pid` is alive.
- **Strict tracking gate.** A session's `cwd` must resolve under a tracked local repo path (`localRepos.isPathTracked(cwd)`, which also understands git worktrees). If it does not resolve, the session is never uploaded or heartbeated. This is intentional and load-bearing; do not loosen it casually.

The server-side `install.sh` / `GET /install.sh` are vestigial. The script is still byte-offset-based against the old ingest API and will fail against the current `fromLineSeq` contract. The desktop app is the only supported watcher client.

### Redis pub/sub -> WebSocket fan-out (`ws/redis-bridge.ts`, `ws/handler.ts`)

Separate `pub`/`sub` ioredis clients satisfy the subscriber-mode requirement. On WS open, the server subscribes the connection to `repo:<id>` for every repo in `user_repos`, plus `user:<userId>`. `RedisBridge` is soft-fail: if Redis cannot connect, `publish`/`subscribe` become no-ops and the HTTP API still works. Server->client is one-way; the server sends `{ type: "ping" }` every 30s.

**Channels and message types in production today:**

- `repo:<id>` carries `{ type: "session_updated" }` from ingest + heartbeat, `{ type: "session_insights_updated" }` from the analyzer scheduler, and `{ type: "pr_activity" }` from the PR poller.
- `user:<userId>` is wired but no publisher uses it yet.

### LLM analyzers (`src/analyzers/`)

Background scheduler (`scheduler.ts`) runs every `ANALYZER_TICK_MS` when `ANTHROPIC_API_KEY` is set. It picks candidate sessions touched in the last hour, runs each registered analyzer through a worker pool of size `ANALYZER_CONCURRENCY`, persists output to `session_insights`, and publishes `{ type: "session_insights_updated", session_id, repo_id, analyzer, output, analyzed_at }` to `repo:<id>` on success.

Two analyzers ship today (`registry.ts`):

- `summary` -> `{ title, description }`
- `rolling_summary` -> `{ summary, highlights[] }`

`llm.ts::callStructured()` is the shared client. It enforces a structured/tool-style response, caches the system prompt ephemerally, and computes per-model cost. When adding a Claude API call here, use the latest model IDs already present in the file and update pricing when model pricing changes.

### PR poller (`social/pr-poller.ts`)

Per-user 60s polling of `https://api.github.com/users/:login/events` with the user's stored encrypted OAuth token, staggered 250ms across users. It filters `PullRequestEvent` (`opened` / `reopened` or merged), dedups via in-memory `lastSeenIdByUser`, and publishes `PrActivityMessage` to `repo:<id>`. The desktop overlay renders this as a celebratory ring/spark animation around the actor's avatar.

### Database

Schema lives in `apps/server/src/db/schema.ts` and is the single source of truth. Migrations live under `apps/server/drizzle/`.

Tables: `users`, `refresh_tokens`, `setup_tokens`, `devices` (unique on `(user_id, device_name)`), `api_keys`, `repos` (unique on lowercased `full_name`, `github_id` nullable), `user_repos`, `device_repo_paths`, `device_excluded_repos`, `sessions`, `events` (PK `(session_id, line_seq)`), `heartbeats`, `session_insights`.

Migration workflow:

1. Edit `src/db/schema.ts`.
2. Run `bun run db:generate` from `apps/server`.
3. Read the generated SQL. For renames or destructive ops, write a custom migration instead of trusting generated output.
4. Run `bun run db:migrate`.
5. Commit schema + migration files together.
6. Never hand-edit Drizzle journal or snapshot metadata.

### Secrets

GitHub OAuth tokens are AES-256-GCM encrypted with `ENCRYPTION_KEY` before insert (`hex(iv):hex(ciphertext)`, `auth/tokens.ts`). Refresh tokens, API keys, and setup tokens are stored as SHA-256 hashes; plaintext is returned exactly once at issuance. Never log or return raw values.

### `@slashtalk/shared` is source-only

No build, no `dist`. Both server and desktop import it directly from TS source via tsconfig path mapping. Runtime values such as `SessionState`, `SOURCES`, and `EVENT_KINDS` work only because they are imported from source, not from a built package. Do not add runtime exports that assume a build step exists.

## Where things live (server)

```text
apps/server/src/
├── index.ts             # boot: redis + createApp + pollers + scheduler
├── app.ts               # Elysia composition; add new plugins here
├── config.ts            # env var loader + defaults
├── db/
│   ├── index.ts         # drizzle connection
│   └── schema.ts        # SOURCE OF TRUTH for all tables
├── auth/
│   ├── github.ts        # OAuth routes + /v1/auth/exchange
│   ├── middleware.ts    # jwtAuth + apiKeyAuth
│   ├── sessions.ts      # JWT/refresh helpers
│   └── tokens.ts        # API-key/setup-token/encryption helpers
├── ingest/
│   ├── routes.ts        # POST /v1/ingest, GET /v1/sync-state, POST /v1/heartbeat
│   ├── classifier.ts    # raw event -> {kind, turnId, callId, eventId, parentId}
│   └── aggregator.ts    # processEvents(): event stream -> SessionUpdates
├── sessions/
│   ├── routes.ts        # /api/session(s)/...
│   ├── snapshot.ts      # row -> SessionSnapshot (+ insights), state computed here
│   └── state.ts         # classifySessionState()
├── social/
│   ├── routes.ts        # /api/feed, /api/feed/users
│   ├── pr-poller.ts     # 60s poll, publishes pr_activity
│   └── github-sync.ts   # repo claiming + matchSessionRepo helpers
├── user/
│   └── routes.ts        # /api/me/*, including POST /api/me/repos (claim)
├── ws/
│   ├── handler.ts       # WS upgrade, channel subscriptions, ping
│   └── redis-bridge.ts  # ioredis pub/sub, soft-fail
├── analyzers/
│   ├── scheduler.ts     # tick loop, candidate selection, worker pool
│   ├── registry.ts      # array of analyzers — add yours here
│   ├── types.ts         # Analyzer interface + context/result types
│   ├── llm.ts           # Anthropic client + pricing
│   ├── publish.ts       # session_insights_updated -> repo:<id>
│   ├── names.ts         # analyzer name string constants
│   ├── summary.ts       # title + description analyzer
│   └── rolling-summary.ts
└── install/             # vestigial install.sh — do not extend
```

## Where things live (desktop)

```text
apps/desktop/src/
├── main/
│   ├── index.ts         # windows + IPC handlers
│   ├── backend.ts       # HTTP client, auth state machine, single-flight refresh
│   ├── uploader.ts      # ~/.claude/projects watcher -> /v1/ingest, strict tracking
│   ├── heartbeat.ts     # ~/.claude/sessions watcher -> /v1/heartbeat
│   ├── ws.ts            # WS client (uses `ws` package, not global WebSocket)
│   ├── rail.ts          # derived heads list, PR activity animation buffer
│   ├── localRepos.ts    # tracked repos store, .git/config parsing, worktree resolution
│   ├── safeStore.ts     # encrypted creds via Electron safeStorage
│   ├── store.ts         # plaintext JSON in app.getPath('userData')
│   ├── macCorners.ts    # Cocoa FFI for overlay corner radius
│   └── emitter.ts       # tiny pub/sub
├── preload/index.ts     # window.chatheads bridge (built as .cjs)
└── renderer/
    ├── overlay/         # rail bubbles, drag, PR celebration
    ├── info/            # session list popover, weather widget
    ├── chat/            # input pill
    ├── response/        # full-window response viewer
    ├── main/            # config UI, sign-in, tracked repos
    ├── statusbar/       # tray popup
    └── shared/          # shared hooks/components/styles
```

## How to add X

### Add a new LLM analyzer

1. Add a name constant in `apps/server/src/analyzers/names.ts`.
2. Create `apps/server/src/analyzers/my-analyzer.ts` exporting an `Analyzer<MyOutput>`.
3. Register it in `apps/server/src/analyzers/registry.ts`.
4. If the UI needs its output, extend `loadInsightsForSessions()` in `apps/server/src/sessions/snapshot.ts` and add any new shared types/fields in `packages/shared/src/index.ts`.
5. Pick a model appropriate to the cost/quality target and update `llm.ts` pricing if needed.
6. Give `shouldRun()` sane refresh thresholds so noisy sessions do not hammer the API.
7. Run `bun run test test/integration.test.ts` and the usual server typecheck/tests.

### Add a new route plugin

1. Create `apps/server/src/<area>/routes.ts` exporting a factory `(db, redis?) => new Elysia({ name: "<area>", prefix: "/api/<area>" }).use(...).get(...)`.
2. Preserve the `name`; Elysia plugin dedup depends on it.
3. Mount it in `apps/server/src/app.ts`.
4. Use the correct auth for the route prefix.
5. Add a test under `apps/server/test/`.
6. Run server typecheck + tests.

### Add a new WebSocket message type

1. Define the message shape in `packages/shared/src/index.ts`, discriminated by `type`.
2. Pick a channel: `repo:<id>` for per-repo, `user:<userId>` for per-user.
3. Publish via `RedisBridge.publish(channel, messageObject)`.
4. Handle it in `apps/desktop/src/main/ws.ts` and forward it to renderers if needed.
5. Keep WS clients tolerant of unknown future `type` values.

### Add a new desktop window or IPC channel

1. Add the window creation/config in `apps/desktop/src/main/index.ts`.
2. Add a renderer entry under `apps/desktop/src/renderer/<name>/` and wire it through `electron.vite.config.ts`.
3. Add any IPC handler in `main/index.ts` and expose it through `preload/index.ts`.
4. Keep preload CommonJS-safe; do not pull in ESM-only packages there casually.

### Add a new database column or table

1. Edit `apps/server/src/db/schema.ts`.
2. Run `bun run db:generate`.
3. Review the generated SQL.
4. Use a custom migration for renames/destructive operations.
5. Run `bun run db:migrate`.
6. Commit schema + migration files together, and never hand-edit Drizzle metadata.

### Add a new event source

1. Add the source string to `SOURCES` in `packages/shared/src/index.ts`.
2. Extend `apps/server/src/ingest/classifier.ts` to normalize the source.
3. Decide whether to write a matching aggregator; today full aggregation is Claude-only.
4. Add source-specific tests under `apps/server/test/`.

## Implementation status (current truth)

Things that are built and shipping:

- Ingest aggregation: tokens, message counts, `inTurn`, top files, recent events, queued commands, `lastUserPrompt`, metadata.
- Heartbeat -> state classification -> Redis fan-out (`session_updated` on state change).
- Session->repo matching during ingest and on device-repo sync.
- LLM analyzer scheduler with `summary` + `rolling_summary`, persisted to `session_insights`, fanned out as `session_insights_updated`.
- PR poller -> `pr_activity` -> desktop celebration animation.
- Desktop rail, drag-to-edge dock, hover-to-peek info popover, sign-in flow, tracked repos UI, and WS reconnect with backoff.

Things that are not built or are still rough:

- "Fork Session" CTA is not implemented anywhere.
- `/api/feed/users` still does N+1 queries.
- `install.sh` / `GET /install.sh` are vestigial and broken against the current ingest API.
- `user:<userId>` Redis channel is wired but unused.
- Desktop test coverage is still minimal compared to server coverage.
- Codex event normalization exists, but Codex session aggregation is not implemented yet.
- WS repo subscriptions are fixed at connection-open time; newly claimed repos do not trigger an in-place resubscribe.

When adding a feature, check whether its upstream dependency is in the "not built or rough" list before wiring against it.

## Conventions

- Run server tests after server changes: `bun run typecheck && bun run test` from `apps/server`.
- Elysia plugins are factories `(db, redis?) => new Elysia({ name, prefix })`. Preserve `name`.
- Route prefix encodes auth. `/v1/*` = API key. `/auth/*` + `/api/*` = JWT.
- Drizzle schema is source of truth. Follow the migration workflow; never hand-edit journal/snapshot metadata.
- TS is strict everywhere and the repo uses ESM.
- Strict tracking in the desktop uploader is intentional; do not loosen it without explicit need.
- Redis fan-out is soft-fail by design; use the existing bridge methods instead of bypassing them.

## Keeping this file in sync

**When you make an architectural change, update `CLAUDE.md` in the same commit.** Specifically: adding/removing a workspace, changing auth, changing ingest protocol or dedup semantics, touching Redis/WS channel design, adding/removing analyzers, closing or opening an implementation gap, adding a new top-level route prefix, changing how `@slashtalk/shared` is consumed, or adding a desktop BrowserWindow. A subtly wrong `CLAUDE.md` is worse than a short one.
