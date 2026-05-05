## Why

`apps/server/src` has outgrown a flat domain list: product domains, platform adapters, background jobs, and static-file handlers all sit at the same level. That makes the server harder to scan, makes new code placement ambiguous, and encourages incidental cross-domain imports.

This change organizes server-owned source modules without changing runtime behavior, public API contracts, database schema, or `packages/shared`.

## What Changes

- Introduce a clearer server source layout that separates server platform code, product domains, background jobs, static delivery, and small shared server utilities.
- Move server-owned modules into the new layout while preserving existing route prefixes, Elysia plugin names, auth semantics, scheduler behavior, and Redis soft-fail behavior.
- Update imports, server docs, and generation scripts that reference moved server paths.
- Keep Drizzle schema and migrations server-owned.
- Keep `packages/shared` untouched for this change; contract-package cleanup can be proposed separately after the server tree settles.
- No breaking runtime behavior is intended.

## Capabilities

### New Capabilities

- `server-source-organization`: Structural requirements for the `apps/server/src` module layout and the invariants that must survive server source moves.

### Modified Capabilities

- None. There are no existing OpenSpec capabilities yet, and this change is not intended to alter product/API behavior.

## Impact

- Affected code: `apps/server/src/**`, `apps/server/test/**`, `apps/server/scripts/**`, and docs that point at server source paths.
- Affected docs: root `AGENTS.md`, `ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/references/drizzle-llms.txt`, `docs/generated/db-schema.md` generation text if paths change, and `apps/server/AGENTS.md`.
- No database migration, generated SQL change, route contract change, package publication change, or desktop/web runtime behavior change is expected.
