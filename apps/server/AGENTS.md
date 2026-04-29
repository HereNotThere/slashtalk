# apps/server (`@slashtalk/server`)

Elysia + Bun backend. Composes `auth`, `ingest`, `sessions`, `social`, `user`, `chat`, `analyzers`, `presence`, and `ws` plugins. See [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the domain map; this file focuses on layout + commands + recipes.

> **Keep this file current.** When you change build commands, scripts, conventions, layout, a plugin name, or the auth split, update this file in the same change.

## Layout

```
src/
├── index.ts         # boot: RedisBridge + createApp() + pollers + scheduler
├── app.ts           # Elysia composition — add new plugins here
├── config.ts        # env loader; throws at boot if required var is unset
├── db/
│   ├── index.ts     # drizzle connection
│   └── schema.ts    # SOURCE OF TRUTH for all tables
├── auth/
│   ├── github.ts    # githubAuth + cliAuth (OAuth + exchange)
│   ├── middleware.ts  # jwtAuth + apiKeyAuth
│   ├── sessions.ts  # issue/rotate/revoke session+refresh tokens; cookie helpers
│   └── tokens.ts    # JWT/refresh/setup/encryption helpers
├── ingest/
│   ├── routes.ts    # POST /v1/ingest, GET /v1/sync-state, POST /v1/heartbeat
│   ├── classifier.ts # raw event → {kind, turnId, callId, eventId, parentId}
│   └── aggregator.ts # processEvents(): event stream → SessionUpdates
├── sessions/
│   ├── routes.ts    # /api/session(s)/...
│   ├── snapshot.ts  # DB row → SessionSnapshot (+ insights)
│   └── state.ts     # classifySessionState()
├── social/
│   ├── routes.ts    # /api/feed, /api/feed/users
│   ├── github-sync.ts # matchSessionRepo() — called from ingest + user routes
│   └── pr-poller.ts # 60s poll, publishes pr_activity
├── user/
│   ├── routes.ts    # /api/me/*, incl. POST /api/me/repos (claim)
│   └── dashboard.ts # /api/users/:login/{prs,standup} — info-card user surface
├── repo/
│   └── overview.ts  # /api/repos/:owner/:name/overview — info-card project surface
├── chat/
│   └── routes.ts    # /api/chat/ask (stateless Q&A)
├── presence/
│   └── routes.ts    # POST /v1/presence/spotify, GET /api/presence/peers; publishes to user:<id> + repo:<id>
├── web/
│   └── routes.ts    # GET /app and /app/* static serving for the installable PWA
├── managed-agent-sessions/
│   └── routes.ts    # PUT/GET /v1/managed-agent-sessions (apiKeyAuth)
├── mcp/
│   ├── routes.ts        # root /mcp Streamable HTTP resource (MCP OAuth + device API key compatibility)
│   └── session-pool.ts  # MCP HTTP session lifecycle
├── ws/
│   ├── handler.ts   # WS upgrade, channel subscriptions, ping
│   └── redis-bridge.ts # ioredis pub/sub, soft-fail
├── analyzers/
│   ├── index.ts           # barrel re-export consumed by src/index.ts
│   ├── scheduler.ts       # tick loop, candidate selection, worker pool
│   ├── registry.ts        # array of Analyzers — add yours here
│   ├── types.ts           # Analyzer<T> interface
│   ├── llm.ts             # callStructured() — Anthropic client + pricing
│   ├── publish.ts         # session_insights_updated → repo:<id>
│   ├── names.ts           # analyzer name string constants
│   ├── event-compact.ts   # shared event → compact-text helpers
│   ├── summary.ts         # title + description analyzer (Haiku 4.5)
│   └── rolling-summary.ts # rolling narrative analyzer (Haiku 4.5)
└── install/         # vestigial install.sh — do not extend
```

Scripts: [`scripts/gen-db-schema.ts`](scripts/gen-db-schema.ts) — regenerates [`docs/generated/db-schema.md`](../../docs/generated/db-schema.md).

## Commands

Run from `apps/server/`:

```sh
bun run dev                         # --watch src/index.ts
bun run start                       # one-shot
bun run typecheck                   # tsc --noEmit
bun run test                        # bun test (ingest, classifier, chat, PR poller, integration)
bun run test test/upload.test.ts    # single file
bun run db:generate                 # drizzle-kit; after editing schema.ts
bun run db:migrate                  # apply pending migrations to $DATABASE_URL
bun run gen:db-schema               # regenerate docs/generated/db-schema.md
bun run gen:db-schema:check         # CI check: fail if db-schema.md is stale
```

From repo root: `bun --filter @slashtalk/server <script>`.

## Environment

[`src/config.ts`](src/config.ts) throws if any required var is unset.

**Required:** `DATABASE_URL`, `REDIS_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY`, `BASE_URL`.

**Optional:** `PORT` (10000), `ANTHROPIC_API_KEY` (analyzer scheduler disabled if unset), `ANALYZER_TICK_MS` (300_000), `ANALYZER_MAX_SESSIONS_PER_TICK` (200), `ANALYZER_CONCURRENCY` (5).

## Auth split

- `/v1/*` → `apiKeyAuth`
- `/mcp` → explicit MCP resource-server exception; accepts MCP OAuth access tokens, plus device API keys for desktop-local proxy and legacy clients
- `/auth/*` + `/api/*` → `jwtAuth`
- `/ws` → browser `session` cookie, else `?token=` JWT/API key

See [core-beliefs #2](../../docs/design-docs/core-beliefs.md#2-route-prefix-encodes-auth). A new auth scheme gets a new plugin in `auth/middleware.ts`, not an overload.

## Adding a route plugin

1. Create `src/<area>/routes.ts` exporting a factory `(db, redis?) => new Elysia({ name: "<area>", prefix: "/<prefix>" }).use(jwtAuth|apiKeyAuth(...))...`.
2. **`name` is required** — Elysia dedups plugins by name. See [core-beliefs #3](../../docs/design-docs/core-beliefs.md#3-elysia-plugin-names-are-required-and-globally-unique).
3. Mount in [`src/app.ts`](src/app.ts) with `.use(yourRoutes(db, redis))`.
4. Auth follows route prefix.
5. Add a test under `test/` using helpers in `test/helpers.ts` (mocks GitHub OAuth + DB).
6. `bun run typecheck && bun run test`.

## Adding an LLM analyzer

1. Add a name constant in [`src/analyzers/names.ts`](src/analyzers/names.ts) and extend `AnalyzerName`.
2. Create `src/analyzers/my-analyzer.ts` exporting `myAnalyzer: Analyzer<MyOutput>` with `name`, `version`, `model`, `shouldRun(ctx)`, `run(ctx)`. Model: [`src/analyzers/summary.ts`](src/analyzers/summary.ts).
3. Register: append to the array in [`src/analyzers/registry.ts`](src/analyzers/registry.ts).
4. If the UI needs the output, extend `loadInsightsForSessions()` in [`src/sessions/snapshot.ts`](src/sessions/snapshot.ts) and add the field to [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts).
5. Pick a model from the allowed list ([core-beliefs #8](../../docs/design-docs/core-beliefs.md#8-latest-claude-model-ids)): `claude-haiku-4-5-20251001` (default for high-volume cheap labels), `claude-sonnet-4-6`, `claude-opus-4-7`. Update pricing in `llm.ts` if you introduce a new ID.
6. Set `shouldRun` thresholds (line-seq delta + min-time) so you don't melt the API on noisy sessions.
7. `bun run test test/integration.test.ts` to confirm scheduler pickup.

## Adding a database column or table

Rules: [core-beliefs #4](../../docs/design-docs/core-beliefs.md#4-drizzle-migrations-are-append-only). Short workflow:

1. Edit [`src/db/schema.ts`](src/db/schema.ts).
2. `bun run db:generate` — read the generated SQL under `drizzle/`.
3. For rename/destructive ops, regenerate with `bunx drizzle-kit generate --custom --name=<slug>`.
4. `bun run db:migrate` against local DB.
5. `bun run gen:db-schema` to refresh the agent-readable schema.
6. Commit schema + SQL + journal/snapshot + `db-schema.md` as ONE commit.
7. **Never** hand-edit `drizzle/meta/_journal.json` or `*_snapshot.json`.

## Adding a WebSocket message type

1. Define the message shape in [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts). Discriminate by `type`.
2. Pick a channel: per-repo broadcasts → `repo:<id>`, per-user → `user:<userId>`.
3. Publish through [`ws/redis-bridge.ts`](src/ws/redis-bridge.ts) (no raw `await redis.publish(...)` — [core-beliefs #7](../../docs/design-docs/core-beliefs.md#7-redis-publishing-is-soft-fail)).
4. Handle on the desktop in [`apps/desktop/src/main/ws.ts`](../../apps/desktop/src/main/ws.ts)'s switch.
5. WS clients must ignore unknown `type` fields — keep this property when adding new messages.

## Adding a new event source (beyond Claude / Codex)

1. Add the source string to `SOURCES` in [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts).
2. Extend [`src/ingest/classifier.ts`](src/ingest/classifier.ts) to map the source's raw events to `EVENT_KINDS`.
3. Aggregation in [`src/ingest/aggregator.ts`](src/ingest/aggregator.ts) is currently Claude-only. Decide: parallel aggregator, or generalize.
4. Add a test file `test/classifier-<source>.test.ts` mirroring `classifier.test.ts`.

## Before committing

```sh
bun run typecheck
bun run test
bun run gen:db-schema:check   # if you touched schema.ts
```

All must pass.
