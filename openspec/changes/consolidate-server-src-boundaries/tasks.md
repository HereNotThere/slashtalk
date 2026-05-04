## 1. Characterize Current Behavior

- [x] 1.1 Inventory auth lookup call sites in route plugins, MCP routes, user/device routes, and WebSocket handling.
- [x] 1.2 Inventory `user_repos` read checks across feed, sessions, repo overview, dashboard, chat tools, and presence.
- [x] 1.3 Inventory session card/snapshot shaping and pull request query/write call sites.
- [x] 1.4 Add or identify focused tests for route-prefix auth behavior, repo visibility authorization, session read shapes, and PR ingest/poller behavior.

## 2. Consolidate Auth Lookup

- [x] 2.1 Introduce a server-local auth identity lookup owner for JWT, API key, MCP token, and WebSocket token verification.
- [x] 2.2 Update existing auth plugins and token consumers to call the shared lookup helpers while preserving plugin names and route-prefix semantics.
- [x] 2.3 Decide and document whether API-key `last_used_at` behavior should be consistent everywhere or preserved per current call site.

## 3. Consolidate Repo Visibility And Access

- [x] 3.1 Introduce a repo visibility/access owner around `user_repos` authorization.
- [x] 3.2 Move feed, session access, repo overview, dashboard, chat tools, and presence authorization checks onto the shared access surface.
- [x] 3.3 Keep repo claim validation separate from cross-user read authorization unless implementation shows a shared helper is genuinely clearer.

## 4. Consolidate Session And PR Read Models

- [ ] 4.1 Introduce a session read-model owner for repeated card/snapshot/session summary shaping.
- [ ] 4.2 Move dashboard, feed, chat-tool, and snapshot callers onto the shared session read surface where they need the same concept.
- [ ] 4.3 Introduce a pull request owner for common PR upserts, dedupe, repo summaries, dashboard summaries, and session enrichment.
- [ ] 4.4 Preserve public response payload shapes and existing PR/session ordering semantics.

## 5. Consolidate Small Utilities Carefully

- [ ] 5.1 Extract request-window/rate-limit helpers only where the same policy is repeated.
- [ ] 5.2 Extract text truncation helpers only where the same display or prompt-budget policy is repeated.
- [ ] 5.3 Extract analyzer run result mapping only within analyzer modules unless another caller appears.

## 6. Coordinate With Source Reorganization

- [ ] 6.1 If this lands before `reorganize-server-src`, keep paths in the current tree but document their intended destination.
- [ ] 6.2 If `reorganize-server-src` lands first, place the new owners directly in the reorganized tree.
- [ ] 6.3 Update `reorganize-server-src` design notes if the chosen owners change the proposed folder map.

## 7. Verify

- [ ] 7.1 Run `bun run typecheck` from `apps/server/`.
- [ ] 7.2 Run `bun run test` from `apps/server/`.
- [ ] 7.3 Inspect response-shape diffs and auth/access tests for accidental behavior changes.
