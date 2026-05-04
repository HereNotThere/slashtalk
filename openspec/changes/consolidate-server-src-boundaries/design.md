## Context

The source inventory found repeated logic in five places that matter for the server move:

- Auth lookup is repeated across JWT/API-key route plugins, user/device routes, MCP routes, and WebSocket connection handling.
- `user_repos` authorization is repeated across feed, sessions, repo overview, presence, dashboard, and chat-tool surfaces.
- Session read-model shaping is partly centralized in `sessions/snapshot.ts`, but routes and chat tools still rebuild similar cards and summaries.
- Pull request state is written, read, and summarized from poller, ingest route, dashboard, repo overview, and session snapshot code.
- Small helpers such as truncation, in-memory request limiting, and analyzer run result mapping recur in nearby modules.

These are good "deepening" candidates: they are not just repeated lines, they are repeated domain decisions. Giving them one owner should make the future tree easier to navigate and reduce security drift.

## Goals / Non-Goals

**Goals:**

- Consolidate repeated server-local behavior that carries authorization, identity, session, PR, or request-limiting meaning.
- Make the eventual `apps/server/src` organization less cosmetic by naming the real module owners.
- Keep behavior stable unless a specific existing divergence is documented and tested as a bug fix.
- Prefer small, reviewable extractions with clear callers over broad route rewrites.

**Non-Goals:**

- No `packages/shared` move, split, or rename.
- No public route, WebSocket, ingest, or MCP protocol change.
- No database schema or migration change.
- No generic repository layer over all Drizzle access.
- No folder-wide move in this change unless it lands as part of `reorganize-server-src`.
- No attempt to deduplicate every small helper if doing so would add more indirection than leverage.

## Decisions

### 1. Treat this as boundary deepening, not a folder move

The change should introduce logical owners that can live in either the current tree or the proposed reorganized tree:

```text
Current tree option                 Reorganized tree option
-------------------                 -----------------------
src/auth/identity.ts                src/domains/auth/identity.ts
src/repo/visibility.ts              src/domains/repos/visibility.ts
src/sessions/read-model.ts          src/domains/sessions/read-model.ts
src/social/pull-requests.ts         src/domains/repos/pull-requests.ts
src/util/rate-limit.ts              src/lib/rate-limit.ts
src/util/text.ts                    src/lib/text.ts
```

Rationale: the valuable decision is ownership. The physical path should follow whichever structural change lands first.

### 2. Make `user_repos` authorization a single read boundary

Cross-user reads must continue to be authorized by `user_repos`, but the query shapes should stop living independently in each route. A server-owned repo visibility module should expose operations such as:

- visible repo full names for a user
- visible user ids for a repo intersection
- session access by caller and session id
- repo-scoped feed/session/dashboard filters

Rationale: this is the highest-leverage consolidation because it protects core belief #13 and affects multiple user-facing surfaces.

Implementation decision: start with `repo/visibility.ts` as the server-local owner for visible repo ids/names, shared repo intersections, visible peers, direct repo access checks, and session access by caller. Existing route callers can move onto this surface incrementally in follow-up tasks.

Follow-up implementation: feed, session access, repo overview, dashboard target resolution, chat tool/card scopes, presence peer reads, WebSocket repo subscriptions, and device repo visibility reads now use this shared surface. Repo claim validation remains in `user/claim.ts` because it verifies GitHub ownership/org membership rather than authorizing cross-user reads.

### 3. Share auth credential lookup without hiding route auth rules

The route plugins should keep encoding auth by prefix, but the database/token lookup details should have one owner. JWT, API key, MCP token, and WebSocket token handling can share pure lookup/verification helpers while the plugins retain their public names and prefixes.

Rationale: auth drift is more dangerous than ordinary duplication. Consolidating the lookup path reduces the chance that one route accepts a stale key, forgets an expected side effect, or returns a subtly different user shape.

Implementation decision: use `auth/resolvers.ts` for credential-specific lookup functions and `auth/instance.ts` for dependency wiring. API-key `last_used_at` updates remain a per-call policy: canonical `apiKeyAuth` and MCP API-key requests update it, while the existing device-repos inline auth replacement and WebSocket query-token auth preserve their previous no-touch behavior.

### 4. Move repeated session shaping into a session read model

Session cards, recent prompts, counts, token totals, activity state, and repo labels should be assembled by a server-local session read-model module. Feed routes, dashboard routes, chat tools, and snapshots should call the same read surface where they need the same concept.

Rationale: the server already has `sessions/snapshot.ts`, but several callers still build related summaries directly. Naming the read model clarifies when a caller wants a session record versus a product-facing session card.

Implementation decision: use `sessions/read-model.ts` to hydrate session rows with heartbeat state, analyzer insights, matched PRs, and optional user/repo labels. Session routes, feed shaping, chat activity, chat session detail, and citation cards now share that hydration surface while preserving their existing response-specific payload shapes.

### 5. Give pull request persistence and read queries one owner

Pull request upserts, ingest dedupe, poller writes, repo overview summaries, dashboard summaries, and session snapshot enrichment should share a pull request module.

Rationale: PR data is currently a cross-cutting secondary read model. Keeping its writes and common reads together reduces repeated Drizzle clauses and makes poller/domain boundaries clearer.

Implementation decision: use `social/pull-requests.ts` as the PR owner for batch upserts, per-session PR enrichment, project overview PR rows, and user/dashboard PR rows. Desktop PR ingest preserves existing `head_ref` update semantics while poller writes remain authoritative for branch/head-ref changes.

### 6. Extract small utilities only when the interface stays obvious

Text truncation, keyed request limiting, per-user request limiting, and analyzer result mapping are valid candidates, but they should be extracted only when at least two call sites clearly share the same semantics.

Rationale: small duplication can be cheaper than a vague helper. The useful extractions here are the ones that carry a named policy: request windowing, display truncation, analyzer persistence mapping.

Implementation decision: use `util/rate-limit.ts` for the repeated in-memory sliding-window limiter used by MCP auth, MCP routes, and repo claim throttling. Use `util/text.ts` for ellipsis truncation used by display snippets and prompt-budget snippets. Keep analyzer run result mapping in `analyzers/scheduler.ts` for now because the inventory did not surface a non-analyzer caller with the same mapping responsibility.

### 7. Coordinate destinations with `reorganize-server-src`

This consolidation is landing before the source move, so the new owners stay in the current tree for review:

- `auth/instance.ts` and `auth/resolvers.ts` should move with `domains/auth`.
- `repo/visibility.ts` and `social/pull-requests.ts` should move with `domains/repos`.
- `sessions/read-model.ts` should move with `domains/sessions`.
- `util/rate-limit.ts` and `util/text.ts` should move with `lib`.

The `reorganize-server-src` design notes now treat these as existing owners to rehome mechanically, not as new interfaces to invent during the folder move.

## Risks / Trade-offs

- Security regressions from auth or repo visibility refactors -> add characterization tests first and keep old route prefixes/plugin names intact.
- Accidental payload changes from session/PR read-model extraction -> compare response shapes in existing tests or add focused snapshots.
- Over-abstracting Drizzle queries -> keep helpers domain-specific instead of introducing a generic repository layer.
- Collision with `reorganize-server-src` path churn -> land one change first or keep consolidation commits narrowly scoped with moved-file review.

## Open Questions

- Should PR ownership live under repos, feed, or a dedicated pull-request domain after the source move?
- Should analyzer result mapping stay under jobs/analyzers, or become a tiny persistence helper shared only by analyzer modules?
- Should text truncation have separate policies for UI display, LLM prompt budget, and database summaries?
