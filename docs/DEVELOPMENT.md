# Development

Getting the slashtalk backend running locally.

## Prerequisites

- [Bun](https://bun.sh) (v1.1+)
- PostgreSQL 16+
- Redis 7+

## 1. Start services

With Docker:

```sh
docker run -d --name slashtalk-pg \
  -e POSTGRES_USER=slashtalk -e POSTGRES_PASSWORD=slashtalk -e POSTGRES_DB=slashtalk \
  -p 5432:5432 postgres:16

docker run -d --name slashtalk-redis \
  -p 6379:6379 redis:7
```

Or use any existing Postgres/Redis instances.

## 2. Configure environment

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

## 3. Install dependencies

```sh
bun install
```

## 4. Set up the database

```sh
cd apps/server
bun run db:generate   # generate migration SQL from Drizzle schema
bun run db:migrate    # apply migrations
```

## 5. Run the server

```sh
cd apps/server
bun run dev
```

The server starts on `http://localhost:10000`. Verify with:

```sh
curl http://localhost:10000/health
# {"status":"ok"}
```

## 6. Explore the API

- **OpenAPI docs**: http://localhost:10000/openapi
- **Health check**: `GET /health`
- **GitHub login**: `GET /auth/github`

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

Migration safety rules live in [`CLAUDE.md`](../CLAUDE.md) (load-bearing memory #4) and [`docs/design-docs/core-beliefs.md`](design-docs/core-beliefs.md). Short version: append-only, never edit `_journal.json` or `*_snapshot.json`, fix bad migrations with a corrective migration.

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

## Desktop dev

See [`apps/desktop/AGENTS.md`](../apps/desktop/AGENTS.md) for desktop-specific commands, layout, and the local-vs-hosted backend env-var dance.

## Project structure

See [`AGENTS.md`](../AGENTS.md) for the full workspace map and per-app pointers.
