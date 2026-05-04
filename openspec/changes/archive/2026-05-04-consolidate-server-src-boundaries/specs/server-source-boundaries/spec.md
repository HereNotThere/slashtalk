## ADDED Requirements

### Requirement: Cross-user reads use one repo visibility owner

Server code SHALL route cross-user read authorization through a single server-local owner based on `user_repos`.

#### Scenario: Feed and sessions share repo visibility

- **WHEN** feed, session, dashboard, repo overview, chat-tool, or presence code reads another user's repo-scoped activity
- **THEN** the caller's visibility is checked through the shared repo visibility owner instead of each route hand-writing an independent `user_repos` query

#### Scenario: Authorization source stays unchanged

- **WHEN** repo visibility helpers are used
- **THEN** `user_repos` remains the source of authorization for cross-user reads

### Requirement: Auth credential lookup is shared without changing route auth boundaries

Server code SHALL share credential lookup and verification helpers for JWT, API key, MCP token, and WebSocket token handling while preserving route-prefix auth semantics.

#### Scenario: Route plugins keep their public contract

- **WHEN** auth lookup is consolidated
- **THEN** `/v1/*`, `/api/*`, `/auth/*`, `/mcp`, and `/ws` keep their existing auth expectations and Elysia plugin names

#### Scenario: Token side effects are intentional

- **WHEN** an auth path updates or does not update token metadata such as `last_used_at`
- **THEN** that behavior is either preserved from the original call site or explicitly documented and tested as a behavior fix

### Requirement: Session read shapes have a shared owner

Server code SHALL assemble repeated session cards, snapshots, activity summaries, token totals, recent prompts, and repo labels through a shared session read-model owner when callers need the same product-facing concept.

#### Scenario: Multiple surfaces need the same session card concept

- **WHEN** feed, dashboard, chat-tool, or snapshot code needs the same session summary fields
- **THEN** the fields are assembled by the shared session read-model owner rather than duplicated in each caller

#### Scenario: Public payloads remain stable

- **WHEN** session shaping is consolidated
- **THEN** existing response field names, nullability, ordering, and visibility behavior remain stable unless separately specified

### Requirement: Pull request data has a shared server owner

Server code SHALL place common pull request upsert, dedupe, summary, and enrichment behavior behind a shared server-local owner.

#### Scenario: Poller and ingest write through one owner

- **WHEN** poller or ingest code records pull request state
- **THEN** common dedupe and upsert behavior is owned by the shared pull request module

#### Scenario: Dashboard, repo overview, and session enrichment share reads

- **WHEN** dashboard, repo overview, or session snapshot code needs pull request summaries
- **THEN** repeated PR query and summary behavior is provided by the shared pull request owner

### Requirement: Small utility extraction is policy-based

Server code SHALL extract small helpers only when the helper represents a shared policy rather than incidental syntax.

#### Scenario: Request limiting is repeated

- **WHEN** two or more server modules enforce the same keyed request-window policy
- **THEN** they use a shared server utility with explicit window and limit configuration

#### Scenario: Text truncation is repeated

- **WHEN** two or more server modules apply the same display, prompt-budget, or summary truncation policy
- **THEN** they use a named helper for that policy rather than unrelated local `truncate` functions

### Requirement: Consolidation remains server-local and behavior-preserving

The consolidation SHALL stay within `apps/server/src` and SHALL NOT move public contracts, change database schema, or alter route/API/WebSocket payload contracts.

#### Scenario: Shared package stays out of scope

- **WHEN** server boundaries are consolidated
- **THEN** `packages/shared` imports and exports remain unchanged

#### Scenario: Database schema stays unchanged

- **WHEN** repeated query logic is moved behind shared owners
- **THEN** Drizzle table definitions, migrations, and generated database docs do not change as part of this consolidation
