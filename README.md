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

## Project structure

```
slashtalk/
├── packages/shared/        # Shared TypeScript types
├── apps/
│   ├── server/             # ElysiaJS backend
│   │   └── src/
│   │       ├── index.ts          # Entry point
│   │       ├── app.ts            # App factory (for testing)
│   │       ├── config.ts         # Env var loading
│   │       ├── db/               # Drizzle schema + client
│   │       ├── auth/             # GitHub OAuth, JWT, API keys
│   │       ├── ingest/           # NDJSON upload + aggregator
│   │       ├── social/           # Feed, repo sync
│   │       ├── sessions/         # Session routes, state, snapshots
│   │       ├── user/             # Profile, devices, setup tokens
│   │       ├── ws/               # WebSocket + Redis pub/sub
│   │       └── install/          # CLI install script
│   └── desktop/            # Electron app (future)
└── specs/                  # Design specs
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
