# slashtalk

A hosted backend that aggregates Claude Code session data, organizes it around GitHub repository membership, and provides a real-time social feed of coding sessions.

## Prerequisites

- [Bun](https://bun.sh) (v1.1+)
- PostgreSQL 16+
- Redis 7+

## Local setup

### 1. Start services

With Docker:

```sh
docker run -d --name slashtalk-pg \
  -e POSTGRES_USER=slashtalk -e POSTGRES_PASSWORD=slashtalk -e POSTGRES_DB=slashtalk \
  -p 5432:5432 postgres:16

docker run -d --name slashtalk-redis \
  -p 6379:6379 redis:7
```

Or use any existing Postgres/Redis instances.

### 2. Configure environment

```sh
cp .env.example apps/server/.env
```

Edit `apps/server/.env` with your values. For local dev, the defaults work if you used the Docker commands above:

```
DATABASE_URL=postgres://slashtalk:slashtalk@localhost:5432/slashtalk
REDIS_URL=redis://localhost:6379
GITHUB_CLIENT_ID=<your GitHub OAuth app client ID>
GITHUB_CLIENT_SECRET=<your GitHub OAuth app client secret>
JWT_SECRET=<any random string>
ENCRYPTION_KEY=<64-char hex string, e.g. openssl rand -hex 32>
BASE_URL=http://localhost:10000
PORT=10000
```

To create a GitHub OAuth app, go to **Settings → Developer settings → OAuth Apps → New OAuth App** with callback URL `http://localhost:10000/auth/github/callback`.

### 3. Install dependencies

```sh
bun install
```

### 4. Set up the database

```sh
cd apps/server
bun run db:generate   # generate migration SQL from Drizzle schema
bun run db:migrate    # apply migrations
```

## Database migrations

`apps/server/src/db/schema.ts` is the source of truth for schema changes.

For normal schema changes:

```sh
cd apps/server
bun run db:generate
bun run db:migrate
```

Workflow:

1. Edit `apps/server/src/db/schema.ts`.
2. Run `bun run db:generate` from `apps/server`.
3. Review the generated SQL in `apps/server/drizzle/`.
4. Apply it with `bun run db:migrate`.
5. Commit the schema change and generated migration files together.

For data migrations or hand-written SQL that Drizzle cannot derive from the schema diff:

```sh
cd apps/server
bunx drizzle-kit generate --custom --name=your_migration_name
```

Then edit the generated `.sql` file and apply it with `bun run db:migrate`.

Important rules:

1. Do not manually edit `apps/server/drizzle/meta/_journal.json`.
2. Do not manually edit snapshot IDs or timestamps in `apps/server/drizzle/meta/*_snapshot.json`.
3. Do not rename or resequence existing migration files after they have been committed.
4. If a migration is wrong, add a new corrective migration instead of mutating an already-shared migration.
5. Review generated SQL before applying it, especially for renames and destructive changes.

### 5. Run the server

```sh
cd apps/server
bun run dev
```

The server starts on `http://localhost:10000`. Verify with:

```sh
curl http://localhost:10000/health
# {"status":"ok"}
```

### 6. Explore the API

- **OpenAPI docs**: http://localhost:10000/openapi
- **Health check**: `GET /health`
- **GitHub login**: `GET /auth/github`

## Running tests

Tests require Postgres and Redis. Start them, then:

```sh
DATABASE_URL=postgres://slashtalk:slashtalk@localhost:5432/slashtalk_test \
REDIS_URL=redis://localhost:6379 \
bun test --cwd apps/server
```

Or with Docker on alternate ports (to avoid clobbering your dev DB):

```sh
docker run -d --name slashtalk-test-pg \
  -e POSTGRES_USER=slashtalk -e POSTGRES_PASSWORD=slashtalk -e POSTGRES_DB=slashtalk_test \
  -p 5433:5432 postgres:16

docker run -d --name slashtalk-test-redis -p 6380:6379 redis:7

DATABASE_URL=postgres://slashtalk:slashtalk@localhost:5433/slashtalk_test \
REDIS_URL=redis://localhost:6380 \
bun test --cwd apps/server
```

## Desktop app (local dev)

By default the packaged desktop talks to the hosted services
(`https://slashtalk.onrender.com` for the API and `/mcp` on the same server
for remote MCP). Local Claude Code and Codex installs point at the desktop-local
proxy (`http://127.0.0.1:37613/mcp`) so the device API key stays in Electron
safeStorage instead of AI-client config files. To point the desktop at a
locally-running backend instead, create `apps/desktop/.env` with:

```
MAIN_VITE_SLASHTALK_API_URL=http://localhost:10000
```

`MAIN_VITE_SLASHTALK_MCP_URL` remains available as a remote-MCP escape hatch
for the desktop proxy and self-session client, but the default remote target is
`MAIN_VITE_SLASHTALK_API_URL + /mcp`. `SLASHTALK_LOCAL_MCP_PORT` can override
the local proxy port for testing.

Then start the backend and desktop from the repo root:

```sh
bun run dev:server
bun run dev:desktop
```

Or run each process separately:

```sh
# Terminal 1: slashtalk API server (port 10000)
cd apps/server && bun run dev

# Terminal 2: desktop
cd apps/desktop && bun run dev
```

Notes:

- The `MAIN_VITE_` prefix is required — electron-vite only exposes prefixed
  env vars to the main process. Plain `SLASHTALK_*` in `.env` is ignored.
  (Plain `SLASHTALK_*` exported in your shell still works as a runtime
  override.)
- Keep API and explicit MCP override URLs pointed at the same environment.
  The desktop device apiKey is minted by the API server and accepted by the
  server-owned `/mcp` route for local-proxy and legacy compatibility. Direct
  Claude Code and Codex clients can also authenticate to the same `/mcp` route
  through MCP OAuth.
- `apps/mcp` is deprecated for the migration window. Only start it when
  testing legacy standalone-MCP behavior.
- For a hosted-API + local-everything-else dev session, comment the local
  URLs out and the desktop falls back to the hosted defaults.

## Project structure

See [`AGENTS.md`](AGENTS.md) for the full map and per-workspace pointers.

```
slashtalk/
├── AGENTS.md               # Canonical entry for agents (Claude Code, Codex, …)
├── ARCHITECTURE.md         # Domain map: ingest, sessions, analyzers, ws, …
├── CLAUDE.md               # Thin redirect + load-bearing memories
├── docs/                   # System of record — design docs, specs, references
│   ├── design-docs/        # core-beliefs.md + topic-level decisions
│   ├── product-specs/      # backend.md (ex-specs/backend.spec.md), upload.md
│   ├── exec-plans/         # active/, completed/, tech-debt-tracker.md
│   ├── generated/          # db-schema.md (auto-generated from Drizzle)
│   ├── references/         # 3rd-party lib notes (Elysia, Drizzle, …)
│   ├── RELIABILITY.md      # resume protocol, heartbeat state machine
│   ├── SECURITY.md         # tokens, encryption, PII
│   └── QUALITY_SCORE.md    # per-domain health grades
├── packages/shared/        # Source-only TS types
└── apps/
    ├── server/             # ElysiaJS backend (auth, ingest, sessions, ws, analyzers)
    ├── desktop/            # Electron overlay, 6 renderer windows + tray/dock chrome
    └── mcp/                # MCP server (being consolidated into server)
```

## Key scripts

| Command | Directory | Description |
|---------|-----------|-------------|
| `bun run dev` | `apps/server` | Start with file watching |
| `bun run start` | `apps/server` | Start without watching |
| `bun run db:generate` | `apps/server` | Generate Drizzle migrations |
| `bun run db:migrate` | `apps/server` | Apply migrations |
| `bun run typecheck` | `apps/server` | TypeScript type check |
| `bun test` | `apps/server` | Run test suite |
