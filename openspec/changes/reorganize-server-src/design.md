## Context

`apps/server/src` currently mixes several kinds of modules at one level:

- product domains: `auth`, `ingest`, `sessions`, `social`, `user`, `chat`, `presence`, `mcp`
- platform adapters: `db`, `ws`, `config`
- static delivery: `web`, `landing`, `install`
- background work: `analyzers`, `social/pr-poller`
- small helpers: `util`, `models`, `correlate`

The current shape still works, but it makes placement decisions fuzzy. New server work has to infer whether a module should be named after a route prefix, product concept, transport, background worker, or implementation detail. This proposal makes the server tree itself communicate those categories.

Important existing constraints:

- `/v1/*`, `/api/*`, `/auth/*`, `/mcp`, and `/ws` auth semantics must stay unchanged.
- Elysia plugin `name` values must remain globally unique.
- Drizzle migrations remain append-only and server-owned.
- Redis publishing remains soft-fail through `RedisBridge`.
- `packages/shared` remains untouched in this change.

## Goals / Non-Goals

**Goals:**

- Give `apps/server/src` a small set of durable top-level categories.
- Preserve runtime behavior while moving source files.
- Keep database schema, migration workflow, and generated schema docs server-owned.
- Make future code placement easier for server domains, jobs, platform adapters, static handlers, and small utilities.
- Update server-facing documentation so future agents land in the new tree correctly.

**Non-Goals:**

- No public API, WebSocket payload, ingest protocol, auth, database schema, or route-prefix behavior changes.
- No `packages/shared` move or split.
- No extraction to `packages/db`.
- No deep persistence abstraction or repository layer in this change.
- No large refactor of query logic, route logic, LLM prompts, or test semantics.

## Decisions

### 1. Organize by module role at the top level

Target shape:

```text
apps/server/src/
├── app.ts
├── index.ts
├── platform/
│   ├── config.ts
│   ├── db/
│   ├── redis/
│   └── http/
├── domains/
│   ├── auth/
│   ├── ingest/
│   ├── sessions/
│   ├── repos/
│   ├── feed/
│   ├── presence/
│   ├── chat/
│   ├── agents/
│   └── mcp/
├── jobs/
│   ├── analyzers/
│   └── pr-poller/
├── static/
│   ├── web-app/
│   ├── blog/
│   ├── landing/
│   └── install/
└── lib/
    ├── correlate/
    ├── models.ts
    ├── semaphore.ts
    ├── time-window.ts
    └── ttl-cache.ts
```

Rationale: this separates stable server concepts from incidental route/file names. `platform` holds process/runtime adapters, `domains` holds request-facing product concepts, `jobs` holds background workers, `static` holds file-serving surfaces, and `lib` holds small server-only helpers.

Alternative considered: keep all folders at `src/` and only rename a few confusing ones. That reduces diff size but does not fix the top-level category mixing that caused the ambiguity.

### 2. Keep DB in `apps/server/src/platform/db`

The database remains a server platform adapter:

- schema source of truth moves with the adapter
- connection creation remains server-config-driven
- `apps/server/drizzle/` migrations remain in place
- schema generation script updates its import and generated-doc path text

Rationale: no other workspace consumes Drizzle tables today, and an earlier architecture direction consolidated MCP database ownership back into `apps/server`. Moving DB to `packages/` would create a package seam without a second adapter or second runtime consumer.

Alternative considered: create `packages/db`. Rejected for this change because it does not improve server source organization enough to justify changing package ownership, migration docs, and workspace dependencies.

### 3. Preserve `packages/shared` as the public contract package

This change may update imports that point to server modules, but it does not move, split, or rename `@slashtalk/shared`.

Rationale: desktop and web both import many shared contracts. Pulling those into server would make non-server clients depend on server source organization, which is a separate design decision.

Alternative considered: move shared contracts under `apps/server/src/contracts`. Deferred. It may be worth exploring later as a package rename/split, but it is not required to make `apps/server/src` clearer.

### 4. Prefer mechanical source moves before deeper interfaces

This change should move files and update imports first. It should not simultaneously introduce persistence modules, route factories, new barrels, or new auth helpers unless a move makes a tiny adapter necessary.

Rationale: behavior-preserving source organization is already broad. Combining it with deeper module design would make the diff harder to review and risk hiding behavioral changes.

Alternative considered: refactor DB access while moving folders. Deferred. Good candidates exist, especially `user_repos` authorization and session snapshot reads, but those deserve separate proposals because they change module interfaces.

### 5. Rename only when the new name clarifies ownership

Some folders should keep their current domain name (`auth`, `ingest`, `sessions`, `chat`, `presence`, `mcp`). Some should be renamed because the current name reflects an incidental route/file:

- `repo` -> `domains/repos`
- `social/routes.ts` -> `domains/feed/routes.ts`
- `social/github-sync.ts` -> `domains/repos/matching.ts`
- `social/pr-poller.ts` -> `jobs/pr-poller`
- `managed-agent-sessions` -> `domains/agents`
- `web`/`landing`/`install` -> `static/*`
- `util` and `correlate` -> `lib/*`

Rationale: source movement should improve navigability, not merely add path depth.

Alternative considered: move folders without renames. Rejected where the old names encode the wrong concept.

## Risks / Trade-offs

- Path churn could obscure accidental behavior changes -> keep edits mechanical, review moved-file diffs carefully, and run the full server test/typecheck suite.
- Docs may become stale after path moves -> update root/server AGENTS maps, architecture docs, development docs, and Drizzle reference docs in the same change.
- Generated DB docs may still point at the old schema path -> update `gen-db-schema` text and run its freshness check.
- Deeper paths may make relative imports noisier -> do not introduce a path-alias change unless implementation proves the relative imports are materially worse; aliasing can be a follow-up.
- Splitting `social` between `feed`, `repos`, and `jobs/pr-poller` may reveal hidden coupling -> keep existing function interfaces initially, then propose deeper module work separately if coupling remains painful.

## Migration Plan

1. Move low-risk platform/static/lib files and update direct imports.
2. Move domain folders and route modules while preserving exported factory names and Elysia plugin names.
3. Move jobs and update boot imports from `index.ts`.
4. Update tests, scripts, and docs to new paths.
5. Run `bun run typecheck && bun run test` from `apps/server/`.
6. Run `bun run gen:db-schema:check` after updating schema-doc generation paths.

Rollback is source-level: because no runtime data or schema migration changes are intended, a revert of the source/docs move should restore the previous layout.

## Open Questions

- Should `analyzers` be purely `jobs/analyzers`, or should LLM insight read/write helpers eventually become `domains/insights`?
- Should `social/pr-ingest-routes.ts` live with `domains/feed`, `domains/repos`, or `jobs/pr-poller` after the split?
- Should server imports get a path alias after the move, or should relative imports remain the repo convention?
