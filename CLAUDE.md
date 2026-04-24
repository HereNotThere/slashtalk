# CLAUDE.md

Guidance for Claude Code working in this repo. Read top-to-bottom before changing anything load-bearing. The "How to add X" recipes near the end are the fastest path to a correct first patch for common features.

## Product intent

**Chat-heads-style presence for Claude Code sessions.** A floating rail of teammate avatars — people who share a GitHub repo with you. Hover to peek into their live sessions: current prompt, files Claude is editing right now, latest tool results, token spend, and an LLM-generated title/summary. Ambient awareness of what your team is building with Claude, with "Fork Session" as the eventual CTA.

The backend tails Claude Code's `~/.claude/projects/*/*.jsonl` event streams from each device, aggregates events into per-session rows, matches sessions to GitHub repos (social graph = repo co-membership), classifies live/busy/idle state at read time, runs LLM analyzers for title/summary, and fans updates over WebSockets.

Authoritative design lives in `specs/backend.spec.md` and `specs/upload.spec.md`. The spec is sometimes ahead of the code; consult both, and update both code and CLAUDE.md when you close a gap.

## Repo layout

Bun workspace monorepo (`bun` is required; do not use npm/pnpm/yarn).

- `apps/server` — ElysiaJS backend. Entry `src/index.ts` boots `RedisBridge`, calls `createApp(db, redis)` (`src/app.ts` composes `githubAuth`, `cliAuth`, `ingestRoutes`, `socialRoutes`, `sessionRoutes`, `userRoutes`, `deviceReposRoutes`, `wsHandler`), then starts the PR poller and the LLM analyzer scheduler.
- `apps/desktop` — Electron app (`@slashtalk/electron`), React + Tailwind v4, **7 BrowserWindows**: `main`, `overlay` (rail pill), `info` (session peek popover), `chat` (input pill), `response` (full-window viewer), `statusbar`/`trayPopup`, `dockPlaceholder` (drag ghost). Talks to backend over HTTP via `src/main/backend.ts` and to renderers via IPC.
- `packages/shared` — source-only TS types (`SessionSnapshot`, `FeedSessionSnapshot`, `SessionState`, `TokenUsage`, `PrActivityMessage`, `SOURCES`, `EVENT_KINDS`, …). No build, no `dist`. Consumers import via tsconfig `paths`.
- `specs/` — `backend.spec.md` and `upload.spec.md` are authoritative. `todo.md` is an aspirational checklist, treat as hints, not truth.
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
bun run build                  # electron-vite build → out/
bun run dist:mac               # build + electron-builder → dist/*.dmg
bun run typecheck              # both tsconfig.node.json and tsconfig.web.json
bun run test                   # bun test (only useLocationWeather.test.ts today)
bun run lint                   # eslint

# packages/shared
bun run typecheck
```

**Run tests often.** After any change in `apps/server/src/`, run `bun run typecheck && bun run test` from `apps/server` before reporting the task done — these are fast (seconds) and cover the ingest pipeline, classifier, refresh flow, PR poller, and end-to-end session lifecycle. CI runs the same commands on every push; do not push a red typecheck. For schema or aggregator changes, prefer running `test/integration.test.ts` and `test/upload.test.ts` first since they exercise the most plumbing.

`apps/server/src/config.ts` throws at boot if any required env var is unset. Required: `DATABASE_URL`, `REDIS_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY`, `BASE_URL`. Optional: `PORT` (10000), `ANTHROPIC_API_KEY` (analyzer scheduler is disabled if unset), `ANALYZER_TICK_MS` (300_000), `ANALYZER_MAX_SESSIONS_PER_TICK` (200), `ANALYZER_CONCURRENCY` (5).

## Architecture that matters

### Auth — two plugins, mutually exclusive routes (`src/auth/middleware.ts`)
- `jwtAuth` — httpOnly `session` cookie (or raw JWT in the `Cookie` header from the desktop app), browser routes (`/auth/*`, `/api/*`). Derives `{ user }`.
- `apiKeyAuth` — `Authorization: Bearer <key>`, SHA-256 compared to `api_keys.key_hash`, CLI/desktop routes (`/v1/*`). Derives `{ user, device }`.
- WS upgrade (`ws/handler.ts`) accepts either via `?token=...` — tries JWT first, then API key.

**Route prefix encodes auth.** `/v1/*` = API key. `/auth/*` + `/api/*` = JWT. Don't mix; if you need a new auth scheme, add a third plugin rather than overloading either.

### OAuth is identity-only
`/auth/github` requests **`read:user read:org` only** — no `repo` scope. We **cannot** call `/user/repos` or read repo contents server-side. Repos are **claimed** on demand: the desktop app reads a local clone's `.git/config`, extracts `owner/name`, and POSTs `/api/me/repos { fullName }`. The user proves possession by being able to clone it — GitHub gated access at clone time. `repos.github_id` is therefore nullable; don't treat its absence as a bug. The old `syncUserRepos` / `POST /api/me/sync-repos` are gone.

Two **display-only** GitHub proxy endpoints exist: `GET /api/me/orgs` and `GET /api/me/orgs/:org/repos`. They decrypt the user's stored OAuth token and proxy `GET /user/orgs` / `GET /orgs/:org/repos` with a 60s in-memory cache. They do **not** feed the social graph or write anything — `/api/feed/users` keeps returning the full org roster. They're not consumed by the desktop today (the tray popup uses locally-tracked repos instead — see "Tray popup" below) but are kept as low-risk building blocks in case a future surface needs them.

### Desktop auth flow
On sign-in: (1) opens browser to `${BACKEND}/auth/github?desktop_port=NNNN` (loopback port chosen by OS), (2) `/auth/github/callback` redirects to `http://127.0.0.1:NNNN/callback?jwt=…&refreshToken=…&login=…` instead of setting cookies, (3) desktop calls `POST /api/me/setup-token` with the JWT, then `POST /v1/auth/exchange` with the setup token to get `{ apiKey, deviceId }`. Both credential sets live in Electron `safeStorage` (Keychain/DPAPI/libsecret). JWT goes to `/api/me/*` as `Cookie: session=…`; API key goes to `/v1/*` as `Authorization: Bearer …`. JWT refresh in `apps/desktop/src/main/backend.ts` is single-flight — concurrent 401s share one `/auth/refresh` call.

### Devices dedupe per `(userId, deviceName)`
`/v1/auth/exchange` upserts on that pair (unique index from migration `0003`) and revokes prior API keys for the reused device. Repeated sign-ins on the same laptop reuse the device row, so `device_repo_paths`, `device_excluded_repos`, and historical `sessions.device_id` survive sign-out/in cycles. On sign-in (and on cold start if creds exist), the desktop calls `GET /v1/devices/:id/repos` and adopts the server's list — server is the recovery source for tracked repos.

### Session state is computed, never stored (`sessions/state.ts`)
`classifySessionState({heartbeatUpdatedAt, inTurn, lastTs})` → `BUSY | ACTIVE | IDLE | RECENT | ENDED`. Thresholds: heartbeat fresh < 30s, active < 30s since last event, recent < 1h. **`in_turn` is the only reliable BUSY signal during a silent thinking block** (zero JSONL events for tens of seconds). It flips on at user prompt or queued command and off at assistant `stop_reason == "end_turn"`. Don't collapse this to "just use lastTs" — `specs/upload.spec.md` "Busy is computed, not observed" calls this out.

### Ingest is resumable and aggregating (`ingest/routes.ts`, `ingest/aggregator.ts`)
Client POSTs NDJSON to `/v1/ingest?session=…&project=…&fromLineSeq=N&prefixHash=…`. The handler:
1. Parses chunks (blank/malformed lines still consume a line-seq slot to keep client/server aligned).
2. Upserts the `sessions` row.
3. Classifies events (`ingest/classify.ts` → `kind`, `turn_id`, `call_id`, `event_id`, `parent_id`).
4. Bulk-inserts `events` with `ON CONFLICT (session_id, line_seq) DO NOTHING` for dedup.
5. **Aggregates** (Claude source only): `processEvents()` returns deltas for `lastTs`, `tokensIn/Out/CacheRead/CacheWrite`, `userMsgs`, `assistantMsgs`, `toolCalls`, `toolErrors`, `inTurn`, `outstandingTools`, `topFilesRead/Edited/Written`, `toolUseNames`, `queued`, `recentEvents`, `lastUserPrompt`, plus metadata (`cwd`, `branch`, `model`, `version`, `title`).
6. Matches `sessions.repo_id` via `matchSessionRepo()` (3 strategies: device local path → project slug → cwd substring) if not already set.
7. Publishes `{ type: "session_updated", session_id, repo_id, … }` to `repo:<id>` if repo is set and any events were accepted.

`POST /v1/heartbeat` upserts the `heartbeats` row, classifies state before/after, and publishes `session_updated` only if state changed. Client uses `GET /v1/sync-state` on startup to learn `serverLineSeq + prefixHash` per session and resume. **Don't change the dedup key or seq semantics without updating `apps/desktop/src/main/uploader.ts` in the same commit.**

### Desktop owns the watcher pipeline
- `apps/desktop/src/main/uploader.ts` — `fs.watch(~/.claude/projects, {recursive:true})`, debounce 150ms per file, ships deltas to `/v1/ingest`. Persists `{byteOffset, lineSeq, prefixHash, size, mtimeMs, tracked}` per session. Concurrency cap of 16 (macOS fd limits). On startup `tracked` is reset to `null` so repo-claim changes since last run are re-evaluated.
- `apps/desktop/src/main/heartbeat.ts` — watches `~/.claude/sessions/*.json`, every 15s + on change posts `/v1/heartbeat` for every session whose `pid` is alive (`kill(pid, 0)`).
- **Strict tracking gate.** A session's first-line `cwd` must resolve under a tracked local repo path (`localRepos.isPathTracked(cwd)`, which understands git worktrees). If it doesn't resolve, the session is never uploaded or heartbeated. This is intentional, validated, and load-bearing — see memory `feedback_strict_tracking`. Don't loosen it.

The server-side `install.sh` / `GET /install.sh` are vestigial: byte-offset-based against the old ingest API, will 400 if invoked. The desktop app is the only supported watcher; delete `install.sh` when nothing else points at it.

### Redis pub/sub → WebSocket fan-out (`ws/redis-bridge.ts`, `ws/handler.ts`)
Separate `pub`/`sub` ioredis clients (ioredis subscriber-mode requirement). On WS open, subscribes to `repo:<id>` for every row in `user_repos`, plus `user:<userId>`. `RedisBridge` is **soft-fail**: if Redis can't connect, `publish`/`subscribe` become no-ops and the HTTP API keeps working. Server→client is one-way (no message acknowledgment); the server sends `{ type: "ping" }` keepalive every 30s.

**Channels and message types in production today:**
- `repo:<id>` carries `{ type: "session_updated" }` (from ingest + heartbeat), `{ type: "session_insights_updated" }` (from analyzer scheduler), `{ type: "pr_activity" }` (from PR poller).
- `user:<userId>` is wired but no publisher uses it yet — reserve for personal notifications.

### LLM analyzers (`src/analyzers/`)
Background scheduler (`scheduler.ts`) runs every `ANALYZER_TICK_MS` (default 5 min) when `ANTHROPIC_API_KEY` is set. Picks up to `ANALYZER_MAX_SESSIONS_PER_TICK` sessions touched in the last hour or never analyzed, runs each registered analyzer through a worker pool of size `ANALYZER_CONCURRENCY`. Output persisted to `session_insights` (composite PK `(session_id, analyzer_name)`); on error, prior output/tokens/cost are preserved and only `analyzedAt + errorText` are updated. On success, publishes `{ type: "session_insights_updated", session_id, repo_id, analyzer, output, analyzed_at }` to `repo:<id>` (`publish.ts`).

Two analyzers ship today (`registry.ts`):
- **`summary`** (Haiku 4.5) → `{ title, description }`. Refreshes when `inputLineSeq` delta ≥ 200 or 10 min since last run.
- **`rolling_summary`** (Haiku 4.5) → `{ summary, highlights[] }`. Refreshes when delta ≥ 50 or 10 min.

`llm.ts::callStructured()` is the shared client: enforces a tool-use response, caches the system prompt with `cache_control: ephemeral`, and computes per-model cost (Haiku/Sonnet/Opus pricing tables — update those when prices change). When adding a Claude API call here, use the latest model IDs (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`).

### PR poller (`social/pr-poller.ts`)
Per-user 60s polling of `https://api.github.com/users/:login/events` with the user's stored (encrypted) OAuth token, staggered 250ms across users. Filters `PullRequestEvent` (action `opened`/`reopened` or `closed && merged`), dedups via in-memory `lastSeenIdByUser` (process restart re-baselines from the head, doesn't replay). On match, publishes `PrActivityMessage` (see `@slashtalk/shared`) to `repo:<id>`. The desktop overlay renders this as a celebratory ring/spark animation around the actor's avatar (`rail.markPrActivity()` in `apps/desktop/src/main/rail.ts`).

### Database
Schema: `apps/server/src/db/schema.ts` (single source of truth). Migrations: `apps/server/drizzle/`.

Tables: `users`, `refresh_tokens`, `setup_tokens`, `devices` (unique on `(user_id, device_name)`), `api_keys`, `repos` (unique on `full_name`, lowercased; `github_id` nullable), `user_repos`, `device_repo_paths`, `device_excluded_repos`, `sessions` (rich aggregates incl. `inTurn`, `topFiles*`, `recentEvents`, `outstandingTools`, `lastUserPrompt`, `serverLineSeq`, `prefixHash`), `events` (PK `(session_id, line_seq)`), `heartbeats`, `session_insights` (PK `(session_id, analyzer_name)`).

Migration workflow (also in `README.md`):
1. Edit `src/db/schema.ts`.
2. `bun run db:generate` (from `apps/server`) — generates SQL under `drizzle/`.
3. Read the generated SQL. For renames or destructive ops, write a custom migration via `bunx drizzle-kit generate --custom --name=…`.
4. `bun run db:migrate` to apply.
5. Commit schema + migration files together.
6. **Never hand-edit `_journal.json` or snapshot JSONs.** Never resequence migrations after commit. The `when` field must be monotonic — see memory `feedback_drizzle_journal_when` for the failure mode.

### Secrets
GitHub OAuth tokens are AES-256-GCM encrypted with `ENCRYPTION_KEY` before insert (`hex(iv):hex(ciphertext)`, `auth/tokens.ts`). Refresh tokens, API keys, and setup tokens are stored as SHA-256 hashes — plaintext returned exactly once at issuance. **Never log or return raw values.**

### `@slashtalk/shared` is source-only
No build, no `dist`. Both `apps/server/tsconfig.json` and `apps/desktop/tsconfig.web.json` map the package to `packages/shared/src` via `paths`. Runtime values (the `SessionState`, `SOURCES`, `EVENT_KINDS` const objects) work only because they're imported from TS source. Don't add a runtime export that depends on a build step.

## Where things live (server)

```
apps/server/src/
├── index.ts             # boot: redis + createApp + pollers + scheduler
├── app.ts               # Elysia composition; add new plugins here
├── config.ts            # env var loader + defaults
├── db/
│   ├── index.ts         # drizzle connection
│   └── schema.ts        # SOURCE OF TRUTH for all tables
├── auth/
│   ├── github.ts        # OAuth routes
│   ├── cli.ts           # /v1/auth/exchange
│   ├── middleware.ts    # jwtAuth + apiKeyAuth
│   └── tokens.ts        # JWT/refresh/setup/encryption helpers
├── ingest/
│   ├── routes.ts        # POST /v1/ingest, GET /v1/sync-state, POST /v1/heartbeat
│   ├── classify.ts      # raw event → {kind, turnId, callId, eventId, parentId}
│   ├── aggregator.ts    # processEvents(): event stream → SessionUpdates
│   └── repo-match.ts    # matchSessionRepo(): cwd/project → repos.id
├── sessions/
│   ├── routes.ts        # /api/session(s)/...
│   ├── snapshot.ts      # row → SessionSnapshot (+ insights), state computed here
│   └── state.ts         # classifySessionState()
├── social/
│   ├── routes.ts        # /api/feed, /api/feed/users  (N+1 today, fine for demo)
│   └── pr-poller.ts     # 60s poll, publishes pr_activity
├── user/
│   └── routes.ts        # /api/me/*, including POST /api/me/repos (claim)
├── ws/
│   ├── handler.ts       # WS upgrade, channel subscriptions, ping
│   └── redis-bridge.ts  # ioredis pub/sub, soft-fail
├── analyzers/
│   ├── scheduler.ts     # tick loop, candidate selection, worker pool
│   ├── registry.ts      # array of Analyzers — add yours here
│   ├── types.ts         # Analyzer<T> interface, AnalyzerContext, AnalyzerResult
│   ├── llm.ts           # callStructured() — Anthropic client + pricing
│   ├── publish.ts       # session_insights_updated → repo:<id>
│   ├── names.ts         # analyzer name string constants
│   ├── summary.ts       # title + description analyzer
│   └── rolling-summary.ts  # presence narrative analyzer
└── install/             # vestigial install.sh — do not extend
```

## Where things live (desktop)

```
apps/desktop/src/
├── main/
│   ├── index.ts         # all 7 BrowserWindows + IPC handlers
│   ├── backend.ts       # HTTP client, auth state machine, single-flight refresh
│   ├── uploader.ts      # ~/.claude/projects watcher → /v1/ingest, strict tracking
│   ├── heartbeat.ts     # ~/.claude/sessions watcher → /v1/heartbeat
│   ├── ws.ts            # WS client (uses `ws` package, NOT global WebSocket)
│   ├── rail.ts          # derived heads list, PR activity animation buffer, client-side peer filter by tracked+selected local repos
│   ├── localRepos.ts    # tracked repos store, .git/config parsing, worktree resolution, per-repo rail-filter selection set
│   ├── safeStore.ts     # encrypted creds via Electron safeStorage
│   ├── store.ts         # plaintext JSON in app.getPath('userData')
│   ├── macCorners.ts    # Cocoa FFI for overlay corner radius (vibrancy can't use CSS clip)
│   └── emitter.ts       # tiny pub/sub
├── preload/index.ts     # window.chatheads bridge (built as .cjs)
└── renderer/
    ├── overlay/         # rail bubbles, drag, PR celebration
    ├── info/            # session list popover, weather widget
    ├── chat/            # input pill (560×80 transparent)
    ├── response/        # full-window response viewer
    ├── main/            # config UI, sign-in, tracked repos
    ├── statusbar/       # tray popup: Add-local-repo button + tracked-repo list with per-row filter toggle (drives rail.ts filter)
    └── shared/          # tailwind.css, common components
```

## How to add X

### Add a new LLM analyzer (e.g. "code-areas-touched", "expertise-tags")
1. Add a name constant: edit `apps/server/src/analyzers/names.ts` — add `export const MY_ANALYZER = "my_analyzer" as const;` and extend the `AnalyzerName` union.
2. Create `apps/server/src/analyzers/my-analyzer.ts` exporting `myAnalyzer: Analyzer<MyOutput>` with `name`, `version`, `model`, `shouldRun(ctx)`, `run(ctx)`. Use `summary.ts` as a template — it shows the `callStructured` JSON-schema tool-use pattern.
3. Register: import and append to the array in `apps/server/src/analyzers/registry.ts`.
4. If the UI needs the output, extend `loadInsightsForSessions()` in `apps/server/src/sessions/snapshot.ts` to map your analyzer's `output` jsonb to a `SessionSnapshot` field, and add the field to `packages/shared/src/index.ts`.
5. Pick a model (`claude-haiku-4-5-20251001` is right for high-volume cheap labels; bump to Sonnet 4.6 / Opus 4.7 only when the task warrants it). Update pricing in `llm.ts` if you use a model not already listed.
6. Set sensible refresh thresholds in `shouldRun()` — line-seq delta + min-time — so you don't melt the API when sessions are noisy.
7. **Run `bun run test test/integration.test.ts`** to confirm the scheduler still picks up clean. The scheduler is fire-and-forget and won't block startup if your analyzer throws, but it'll spam logs.

### Add a new route plugin
1. Create `apps/server/src/<area>/routes.ts` exporting a factory `(db, redis?) => new Elysia({ name: "<area>", prefix: "/api/<area>" }).use(jwtAuth(...)).get(...)`.
2. The `name` is **required** for Elysia's plugin dedup — preserve it on edits, never duplicate it across files.
3. Mount in `apps/server/src/app.ts` by calling `.use(yourRoutes(db, redis))`.
4. Auth: `/v1/*` → `apiKeyAuth`, `/auth/*` + `/api/*` → `jwtAuth`. New auth schemes get a new plugin in `auth/middleware.ts`, not an overload.
5. Add a test under `apps/server/test/` using the helpers in `test/helpers.ts` (already mocks GitHub OAuth, sets up the DB).
6. Run `bun run typecheck && bun run test` from `apps/server`.

### Add a new WebSocket message type
1. Define the message shape in `packages/shared/src/index.ts` (e.g. `MyMessage = { type: "my_event", … }`). Discriminate by `type` so the desktop's switch in `apps/desktop/src/main/ws.ts` can route it.
2. Pick a channel: per-repo broadcasts → `repo:<id>`, per-user → `user:<userId>`.
3. Publish via `redis.publish(channel, JSON.stringify(message))`. Soft-fail is automatic.
4. Handle on the desktop in `apps/desktop/src/main/ws.ts` (the `onmessage` switch). Forward via IPC to whichever renderer needs it.
5. WS clients should ignore unknown `type` fields — keep this property when you add new ones (forward-compat).

### Add a new desktop window or IPC channel
1. Window: define dimensions/vibrancy/transparency in `apps/desktop/src/main/index.ts` near the existing `createOverlayWindow()` etc. Add a renderer entry under `apps/desktop/src/renderer/<name>/` and register it in `electron.vite.config.ts`'s renderer `input` map.
2. IPC: add an `ipcMain.handle('your:channel', …)` in `main/index.ts` and a corresponding bridge method in `preload/index.ts` (typed on `ChatHeadsBridge`). The preload is built as CommonJS (`.cjs`) — don't import ESM-only packages there.
3. Tailwind v4 styles live in `apps/desktop/src/renderer/shared/tailwind.css` (`@tailwindcss/vite` plugin).

### Add a new database column or table
1. Edit `apps/server/src/db/schema.ts`.
2. `bun run db:generate` from `apps/server`. Read the generated SQL under `drizzle/`.
3. For destructive or rename operations, regenerate as `--custom` and write the SQL by hand.
4. `bun run db:migrate` against your local DB. Verify with `psql`.
5. Commit `schema.ts`, the new SQL, the journal/snapshot updates **as a single commit**. Do not hand-edit the journal or snapshot JSON.
6. CI applies the migration against a fresh test DB, so a broken migration fails CI loudly.

### Add a new event source (beyond Claude / Codex)
1. Add the source string to `SOURCES` in `packages/shared/src/index.ts`.
2. Extend `apps/server/src/ingest/classify.ts` to map the source's raw events to `EVENT_KINDS`.
3. Aggregation in `apps/server/src/ingest/aggregator.ts` is currently Claude-only (`processEvents` is gated on `source === "claude"`); decide whether to write a parallel aggregator or to generalize.
4. Write a new test file `apps/server/test/classifier-<source>.test.ts` mirroring `classifier.test.ts`.

## Implementation status (current truth)

Things that are **built and shipping**:
- Ingest aggregation: tokens, message counts, `inTurn`, top files, recent events, queued commands, `lastUserPrompt`, metadata. Per-event in `ingest/aggregator.ts::processEvents()`.
- Heartbeat → state classification → Redis fan-out (`session_updated` on state change).
- Session→repo matching at ingest time (3-strategy `matchSessionRepo`).
- LLM analyzer scheduler with `summary` + `rolling_summary`, persisted to `session_insights`, fanned out as `session_insights_updated`.
- PR poller → `pr_activity` → desktop celebration animation.
- Desktop rail with 7 windows, drag-to-edge dock, hover-to-peek info popover, sign-in flow, tracked repos UI, WS reconnect with backoff.
- Tray popup = **local-repo picker**: an "Add local repo" button opens a folder dialog, validates a GitHub remote in `.git/config`, and registers the repo via `/api/me/repos` + `/v1/devices/:id/repos`. Added repos appear in the popup with a checkbox each; the rail filter (client-side in `rail.ts`) shows only peers whose sessions land on a tracked-and-selected repo. Selection state lives in `localRepos.ts` and persists across launches. Before any repo is added the rail passes through (shows everyone in the social graph); after that, deselecting all repos yields an empty rail — the filter is local-only, backend keeps broadcasting the full org roster on `/api/feed/users`.

Things that are **not built or are rough**:
- "Fork Session" CTA — not implemented anywhere.
- `/api/feed/users` does N+1 queries (3 per peer). Fine for demo, rework before real load.
- The desktop "main" config window is functional but minimal — no settings panel, no theming.
- `install.sh` / `GET /install.sh` are vestigial and broken against the current ingest API. Delete when nothing else points at it.
- `user:<userId>` Redis channel is wired but unused.
- Desktop test coverage is essentially zero (one weather util test). Server tests cover the load-bearing pipeline well.

When adding a feature, check whether its upstream dependency is in the "not built" list before wiring against it.

## Conventions

- **Run tests after server changes.** `bun run typecheck && bun run test` from `apps/server` is fast (seconds). For aggregator/schema changes, also run `test/integration.test.ts` and `test/upload.test.ts`. Don't skip this.
- **Elysia plugins are factories** `(db, redis?) => new Elysia({ name, prefix })`. The `name` is required for Elysia's dedup — preserve it on edits.
- **Route prefix encodes auth.** `/v1/*` = API key, `/auth/*` + `/api/*` = JWT. Don't mix.
- **Drizzle schema is source of truth.** Follow the migration workflow above; never hand-edit journal/snapshot metadata (see memory `feedback_drizzle_journal_when`).
- **TS is strict everywhere.** All tsconfigs use `moduleResolution: bundler` and ESM (`"type": "module"`).
- **Strict tracking** in the desktop uploader is intentional — sessions whose cwd isn't under a claimed local repo never ship. Don't loosen this without explicit user direction (see memory `feedback_strict_tracking`).
- **Soft-fail Redis.** Don't add `await redis.publish()` calls that throw on disconnect; use the bridge methods that already swallow errors.
- **Latest Claude models for the analyzer**: Haiku 4.5 (`claude-haiku-4-5-20251001`), Sonnet 4.6 (`claude-sonnet-4-6`), Opus 4.7 (`claude-opus-4-7`). Update `llm.ts` pricing when adding a new model.

## Keeping this file in sync

**When you make an architectural change, update CLAUDE.md in the same commit.** Specifically: adding/removing a workspace, changing the auth model, changing the ingest protocol or event-dedup semantics, touching the Redis pub/sub channel design, adding/removing analyzers, closing or opening an "Implementation status" gap, adding a new top-level route prefix, changing how `@slashtalk/shared` is consumed, or adding a desktop BrowserWindow. If a change would invalidate a claim in this file, fix the claim — a subtly wrong CLAUDE.md is worse than a missing one.
