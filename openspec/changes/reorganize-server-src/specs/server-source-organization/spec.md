## ADDED Requirements

### Requirement: Server source has durable top-level categories

`apps/server/src` SHALL organize server-owned modules into durable top-level categories that distinguish process/platform adapters, product domains, background jobs, static delivery, and small server-only helpers.

#### Scenario: Locate a platform adapter

- **WHEN** a maintainer needs to find server runtime adapters such as config, database, Redis, or HTTP/static helpers
- **THEN** those modules are located under `apps/server/src/platform` or another documented platform category

#### Scenario: Locate product domain code

- **WHEN** a maintainer needs to find request-facing product behavior such as auth, ingest, sessions, feed, repos, chat, presence, agents, or MCP
- **THEN** those modules are located under `apps/server/src/domains`

#### Scenario: Locate background work

- **WHEN** a maintainer needs to find scheduler or poller code that runs outside direct request handling
- **THEN** those modules are located under `apps/server/src/jobs`

#### Scenario: Locate static delivery code

- **WHEN** a maintainer needs to find server-owned static-file handlers for the web app, blog, landing page, or install script
- **THEN** those modules are located under `apps/server/src/static`

### Requirement: Source organization preserves runtime contracts

The source reorganization SHALL preserve existing server runtime behavior, including route prefixes, auth semantics, Elysia plugin names, WebSocket message semantics, Redis soft-fail behavior, scheduler startup behavior, and database schema behavior.

#### Scenario: Route prefixes remain stable

- **WHEN** the reorganized server starts
- **THEN** existing `/v1/*`, `/api/*`, `/auth/*`, `/mcp`, `/ws`, `/app/*`, `/blog/*`, and `/` surfaces are mounted with the same auth expectations as before the move

#### Scenario: Plugin names remain stable

- **WHEN** route plugins are moved into the new source layout
- **THEN** every Elysia plugin keeps a globally unique `name` value

#### Scenario: Redis publishing remains soft-fail

- **WHEN** moved server modules publish WebSocket events
- **THEN** they continue to publish through `RedisBridge` rather than raw route-level Redis calls

### Requirement: Database ownership remains server-local

The Drizzle schema, connection creation, migrations, migration metadata, and generated schema documentation SHALL remain owned by `apps/server`.

#### Scenario: Schema source path changes

- **WHEN** the Drizzle schema file is moved within `apps/server/src`
- **THEN** `apps/server/drizzle.config.ts`, schema generation scripts, and generated DB documentation reference the new server-local path

#### Scenario: Migrations are not rewritten

- **WHEN** the server source tree is reorganized
- **THEN** committed migration SQL files, migration snapshot files, and the migration journal are not renamed, resequenced, or hand-edited as part of the move

### Requirement: Shared contracts remain out of scope

The server source reorganization SHALL NOT move, split, or rename `packages/shared` or alter the public request, response, or WebSocket payload contracts exported from `@slashtalk/shared`.

#### Scenario: Desktop and web keep shared imports

- **WHEN** desktop and web code are typechecked after the server source reorganization
- **THEN** their `@slashtalk/shared` imports continue to resolve without depending on `@slashtalk/server` source paths

#### Scenario: Shared cleanup is proposed separately

- **WHEN** maintainers decide to reorganize or rename shared contracts
- **THEN** that work is captured in a separate proposal from the server source reorganization

### Requirement: Server documentation follows moved paths

Documentation that maps server source files SHALL be updated in the same change as the source reorganization.

#### Scenario: Agent map is current

- **WHEN** a maintainer reads root `AGENTS.md`, `ARCHITECTURE.md`, or `apps/server/AGENTS.md` after the move
- **THEN** the documented server layout and common-edit recipes point to the reorganized paths

#### Scenario: Drizzle workflow docs are current

- **WHEN** a maintainer reads DB workflow documentation after the move
- **THEN** schema edit, migration generation, and generated-doc refresh instructions point to the reorganized server-local schema path
