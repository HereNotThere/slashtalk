# Architecture

Domain map for slashtalk. For rules that shape these domains, see [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md). For reliability + state-machine detail, see [`docs/RELIABILITY.md`](docs/RELIABILITY.md). For schema, see [`docs/generated/db-schema.md`](docs/generated/db-schema.md).

## System outline

```
 Desktop (Electron, 7 windows)            Server (Elysia, one process)
 ┌───────────────────────────────┐        ┌───────────────────────────────┐
 │ watcher pipeline              │        │ auth  (OAuth, JWT, API keys)  │
 │  uploader   → /v1/ingest      │──HTTPS→│ ingest  (NDJSON, aggregator)  │
 │  heartbeat  → /v1/heartbeat   │        │ sessions  (/api/…, snapshot)  │
 │                               │        │ social  (feed + PR poller)    │
 │ ws client  ← /ws              │←──WSS──│ ws  (handler + RedisBridge)   │
 │                               │        │ user  (me/devices/repo-claim) │
 │ backend client (single-flight │        │ chat  (/api/chat, Q&A)        │
 │  refresh, safeStorage creds)  │        │ analyzers  (LLM scheduler)    │
 │                               │        │ presence  (now-playing)       │
 └───────────────────────────────┘        └───────────────┬───────────────┘
                                                          │
                                                  Postgres + Redis
```

## Server domains (`apps/server/src/`)

### `auth`
GitHub OAuth (identity-only, `read:user read:org`) + JWT session cookie + refresh tokens + API keys + setup tokens.

- **Files:** `auth/github.ts` (`githubAuth`, `cliAuth`), `auth/middleware.ts` (`jwtAuth`, `apiKeyAuth`), `auth/tokens.ts` (encryption/hashing/JWT helpers).
- **Tables:** `users`, `refresh_tokens`, `setup_tokens`, `devices`, `api_keys`.
- **Routes:** `GET /auth/github`, `GET /auth/github/callback`, `POST /auth/refresh`, `POST /auth/logout`, `POST /v1/auth/exchange`, `POST /api/me/setup-token`.
- **See:** [`docs/SECURITY.md`](docs/SECURITY.md).

### `ingest`
NDJSON uploader endpoint; classifies events; aggregates per-session deltas; matches sessions to repos.

- **Files:** `ingest/routes.ts`, `ingest/classifier.ts`, `ingest/aggregator.ts` (repo matching lives in `social/github-sync.ts::matchSessionRepo`).
- **Tables:** writes `sessions`, `events`, `heartbeats`; reads `device_repo_paths`, `device_excluded_repos`, `repos`.
- **Routes:** `POST /v1/ingest`, `GET /v1/sync-state`, `POST /v1/heartbeat`.
- **Publishes:** `session_updated` on `repo:<id>` when events land or state flips.
- **See:** [`docs/RELIABILITY.md`](docs/RELIABILITY.md#ingest-resume-protocol), [`docs/product-specs/upload.md`](docs/product-specs/upload.md).

### `sessions`
Read-side: snapshot assembly + state classification.

- **Files:** `sessions/routes.ts`, `sessions/snapshot.ts`, `sessions/state.ts`.
- **Tables:** reads `sessions`, `heartbeats`, `session_insights`, `repos`, `users`.
- **Routes:** `GET /api/sessions`, `GET /api/session/:id`, `GET /api/session/:id/events`.
- **State is computed at read time**, not stored — see [`docs/RELIABILITY.md`](docs/RELIABILITY.md#heartbeat--state-machine).

### `social`
Feed (social graph = repo co-membership) + PR-activity poller.

- **Files:** `social/routes.ts`, `social/pr-poller.ts`, `social/github-sync.ts` (owns `matchSessionRepo`, called from `ingest/routes.ts` and `user/routes.ts`).
- **Tables:** reads `user_repos`, `sessions`, `users`, `repos`.
- **Routes:** `GET /api/feed`, `GET /api/feed/users`.
- **Publishes:** `pr_activity` on `repo:<id>` from the 60-second PR poller (stores encrypted OAuth token per user).

### `presence`
Per-user presence events (e.g. Spotify now-playing) — written from the desktop, read by peers.

- **Files:** `presence/routes.ts` (exports `spotifyPresenceRoutes` at `/v1`, `presenceReadRoutes` at `/api`).
- **Routes:** `POST /v1/presence/spotify`, `GET /api/presence/peers`.
- **Publishes:** presence events on `user:<userId>` and (fan-out) `repo:<id>` for every repo the user shares.

### `user`
Profile + device + repo-claim management.

- **Files:** `user/routes.ts` (exports `userRoutes`, `deviceReposRoutes`).
- **Tables:** writes `devices`, `device_repo_paths`, `device_excluded_repos`, `repos`, `user_repos`.
- **Routes:** `GET /api/me`, `GET /api/me/devices`, `DELETE /api/me/devices/:id`, `GET /api/me/repos`, `POST /api/me/repos` (claim), `GET /v1/devices/:id/repos`, `POST /v1/devices/:id/repos`.

### `chat`
Team-presence Q&A. Stateless server; client owns the thread.

- **Files:** `chat/routes.ts` (plus helpers referenced from `app.ts`).
- **Routes:** `POST /api/chat/ask`.
- **Reads:** session snapshots + insights via the same access-control rules as `/api/feed`.

### `ws`
WebSocket upgrade + Redis pub/sub bridge.

- **Files:** `ws/handler.ts`, `ws/redis-bridge.ts`.
- **Routes:** `GET /ws?token=...` (accepts JWT or API key).
- **Channels:** subscribes a connection to `repo:<id>` for every row in `user_repos`, plus `user:<userId>`.
- **Soft-fail:** Redis errors in `RedisBridge.publish`/`subscribe` are swallowed so HTTP stays up. See [core-beliefs #7](docs/design-docs/core-beliefs.md#7-redis-publishing-is-soft-fail).

### `analyzers`
Background LLM scheduler that produces session insights (title/description, rolling summary) via Anthropic.

- **Files:** `analyzers/index.ts` (barrel), `analyzers/scheduler.ts`, `analyzers/registry.ts`, `analyzers/types.ts`, `analyzers/llm.ts`, `analyzers/publish.ts`, `analyzers/names.ts`, `analyzers/summary.ts`, `analyzers/rolling-summary.ts`, `analyzers/event-compact.ts`.
- **Tables:** reads `sessions`; writes `session_insights`.
- **Publishes:** `session_insights_updated` on `repo:<id>` per analyzer run.
- **Disabled** if `ANTHROPIC_API_KEY` is unset.
- **See:** [`docs/references/anthropic-sdk-llms.txt`](docs/references/anthropic-sdk-llms.txt), [core-beliefs #8](docs/design-docs/core-beliefs.md#8-latest-claude-model-ids).

### `install` (vestigial)
`install/install.sh` is served at `GET /install.sh` but targets the old byte-offset ingest API and will 400 if invoked. Scheduled for removal — see [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md). **Do not extend.**

## Desktop architecture (`apps/desktop/src/`)

7 BrowserWindows orchestrated from a single main process. Detailed layout in [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md).

### Watcher pipeline
- `main/uploader.ts` — `fs.watch(~/.claude/projects, {recursive:true})` + `~/.codex/sessions`, debounce 150 ms, concurrency cap 16, ships deltas to `/v1/ingest`. Strict-tracking gate runs before every upload ([core-beliefs #6](docs/design-docs/core-beliefs.md#6-strict-tracking-gate-in-the-desktop-uploader)).
- `main/heartbeat.ts` — every 15 s + on fs-change, posts `/v1/heartbeat` for each live session (`process.kill(pid, 0)` liveness).

### Transport
- `main/backend.ts` — HTTP client with single-flight JWT refresh + API-key headers. 401 on JWT auth triggers `/auth/refresh`; 401 on API-key auth clears credentials.
- `main/ws.ts` — WS client (`ws` package) with exponential-backoff reconnect, routes messages to renderers via `main/emitter.ts` and IPC.

### Credential + state
- `main/safeStore.ts` — Electron `safeStorage` (Keychain/DPAPI/libsecret) for JWT + API key.
- `main/store.ts` — plaintext JSON in `app.getPath('userData')` for non-secret state.
- `main/localRepos.ts` — tracked-repo list, `.git/config` parsing, worktree resolution. Rehydrates from server on sign-in.

### UI / windows
Seven windows: `main` (config), `overlay` (rail), `info` (peek popover), `chat` (input pill), `response` (full viewer), `statusbar` + `trayPopup`, `dockPlaceholder` (drag ghost). Tailwind v4 via single shared `tailwind.css`.

## MCP surface

`apps/server` serves the consolidated MCP HTTP resource at root `/mcp` and owns managed-agent session ingest at `/v1/managed-agent-sessions`. `/mcp` accepts standards-aligned MCP OAuth access tokens for direct Claude Code and Codex clients, while retaining Slashtalk device API key compatibility for the desktop-local proxy and legacy installs. `/v1/managed-agent-sessions` remains device API key authenticated. `apps/mcp/` remains in the repo as the deprecated standalone service for one migration window; new MCP capability should land in `apps/server`.

## Shared types (`packages/shared/src/`)

Single file (`index.ts`) exporting types + runtime const objects (`SessionState`, `SOURCES`, `EVENT_KINDS`, `PROVIDERS`, …). **Source-only** — see [core-beliefs #5](docs/design-docs/core-beliefs.md#5-slashtalkshared-is-source-only).

## Cross-cutting concerns

- **Config.** `apps/server/src/config.ts` loads env vars and throws at boot if any required var is unset.
- **DB.** `apps/server/src/db/index.ts` wires Drizzle to Postgres. Schema is the single source of truth ([core-beliefs #4](docs/design-docs/core-beliefs.md#4-drizzle-migrations-are-append-only)).
- **Redis.** Only accessed via `RedisBridge` ([core-beliefs #7](docs/design-docs/core-beliefs.md#7-redis-publishing-is-soft-fail)).

## Data flow at a glance

**Upload.** desktop watcher → `POST /v1/ingest` → aggregator writes to `sessions` + `events` → publish `session_updated` on `repo:<id>` → WS fan-out → desktops re-fetch via `/api/feed` or `/api/session/:id`.

**Insight.** scheduler picks stale sessions → runs analyzers (`summary`, `rolling_summary`) → writes `session_insights` → publish `session_insights_updated` → desktops update snapshots.

**PR activity.** PR poller → per-user `GET /users/:login/events` → filter + dedup → publish `pr_activity` on `repo:<id>` → overlay rail plays celebration animation.

## What lives where (quick lookup)

- **Add a route plugin** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-a-route-plugin)
- **Add an analyzer** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-an-llm-analyzer)
- **Add a database table** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-a-database-column-or-table)
- **Add a BrowserWindow or IPC channel** → [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)
- **Add a shared type** → [`packages/shared/AGENTS.md`](packages/shared/AGENTS.md#adding-a-new-type)
- **Add a WebSocket message type** → rules in [`apps/server/AGENTS.md`](apps/server/AGENTS.md) + consumer in [`apps/desktop/src/main/ws.ts`](apps/desktop/src/main/ws.ts).
