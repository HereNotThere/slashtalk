## Why

`apps/server/src` has several repeated behaviors that make the planned source move harder to review. The repetition is not mostly copy-pasted syntax; it is the same server concepts being re-expressed in route handlers, WebSocket handlers, background jobs, and read models.

The clearest examples are auth credential lookup, `user_repos` visibility checks, session card/snapshot hydration, pull request persistence/read queries, small in-memory limiters, and text truncation helpers. If the folder move happens first, these behaviors may be scattered into the new tree with better names but the same hidden duplication.

This change proposes server-local consolidation before, or alongside, `reorganize-server-src`.

## What Changes

- Introduce explicit server-owned boundaries for repeated auth, repo visibility, session read-model, pull request, and small utility behavior.
- Preserve existing route prefixes, Elysia plugin names, auth semantics, database schema, Redis behavior, and API payload contracts.
- Keep `packages/shared` out of scope.
- Keep the folder reorganization itself in `reorganize-server-src`; this change is about deciding which repeated logic deserves a single owner.
- Add characterization coverage before extracting behavior where the current behavior is load-bearing or security-sensitive.

## Capabilities

### New Capabilities

- `server-source-boundaries`: Behavioral requirements for consolidating repeated server logic inside `apps/server/src`.

### Related Changes

- `reorganize-server-src`: complementary structural move. This consolidation change can land before that move, or its logical owners can be placed directly into the new layout if the reorganization lands first.

## Impact

- Affected code: `apps/server/src/auth/**`, `apps/server/src/mcp/**`, `apps/server/src/ws/**`, `apps/server/src/user/**`, `apps/server/src/repo/**`, `apps/server/src/social/**`, `apps/server/src/sessions/**`, `apps/server/src/chat/**`, `apps/server/src/presence/**`, `apps/server/src/analyzers/**`, and small server helpers.
- Affected tests: server auth, repo access, session feed/read-model, PR ingest/poller, and MCP/WS auth tests where present.
- No database migration, public API shape change, package move, or `packages/shared` change is intended.
