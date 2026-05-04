# Step 1 Inventory: Current Server Boundaries

This inventory characterizes current behavior for step 1 of `consolidate-server-src-boundaries`. It does not propose app-code changes; it names the call sites and test coverage that should guide later extraction.

## 1.1 Auth Lookup Call Sites

### Route Plugin Auth

| Surface | Location | Current behavior | Consolidation note |
| --- | --- | --- | --- |
| JWT route plugin | `apps/server/src/auth/middleware.ts:23` | Reads the `session` cookie, verifies the JWT, loads a user by `payload.sub`, checks `credentialsRevokedAt`, returns a broad `user` shape. | This is the main `/api/*` and `/auth/*` auth owner today. A shared helper should preserve cookie/JWT failure semantics while allowing injected DB access. |
| API-key route plugin | `apps/server/src/auth/middleware.ts:63` | Reads `Authorization: Bearer`, hashes token, loads `api_keys`, loads user/device, updates `api_keys.last_used_at`, returns `{ user, device }`. | This is the canonical `/v1/*` device-key path. |
| Device repos inline auth | `apps/server/src/user/routes.ts:92` | Defines `device-repos/auth` and repeats API-key lookup manually for `/v1/devices/*`. It loads user/device but does not update `last_used_at`. | This is the most obvious drift from `apiKeyAuth`. It preserves a route-specific Elysia plugin name, but the lookup body is duplicated. |
| User location auth | `apps/server/src/user/routes.ts:367` | Uses canonical `apiKeyAuth` for `/v1/me/location`. | Good consumer to keep unchanged while moving lookup internals. |
| Ingest, PR ingest, presence, managed-agent sessions | `apps/server/src/ingest/routes.ts:32`, `apps/server/src/social/pr-ingest-routes.ts:31`, `apps/server/src/presence/routes.ts:53`, `apps/server/src/managed-agent-sessions/routes.ts:18` | Use canonical `apiKeyAuth`. | These should be behavior-preserving consumers of the shared lookup owner. |

### MCP And WebSocket Auth

| Surface | Location | Current behavior | Consolidation note |
| --- | --- | --- | --- |
| MCP HTTP resource | `apps/server/src/mcp/routes.ts:108` | Accepts Bearer token. Checks API key first, updates `last_used_at`, returns user/device/method. If no API key, checks MCP OAuth access token hash, revoked/expiry/resource/scope, then loads user. | This is intentionally not a normal `/v1/*` route, but the API-key half should share the canonical lookup and side-effect policy. OAuth access-token lookup is MCP-specific. |
| MCP OAuth authorize | `apps/server/src/mcp/auth.ts:153`, `apps/server/src/mcp/auth.ts:275` | Reads `session` cookie directly, verifies JWT, loads user, checks credential freshness. Missing/invalid session redirects to GitHub sign-in instead of 401. | This duplicates JWT lookup but has a different failure contract. A shared helper should return null; the route keeps redirect behavior. |
| WebSocket open | `apps/server/src/ws/handler.ts:25` | Accepts `?token=` as JWT first, then API key. If no query token, accepts cookie JWT only from allowed origins. On success subscribes to `repo:<id>` channels from `user_repos` plus `user:<id>`. Unauthorized closes with code `4001`. | Query-token API-key path returns only `userId`, does not update `last_used_at`, and does not load device. Cookie path duplicates JWT lookup. |
| WebSocket helpers | `apps/server/src/ws/handler.ts:83`, `apps/server/src/ws/handler.ts:91`, `apps/server/src/ws/handler.ts:131` | Local JWT/API-key helper functions duplicate auth lookup. | Shared lookup can reduce drift, but the WS close-code and origin-guard behavior should stay in `ws`. |

### Auth Side-Effect Matrix

| Credential path | Loads device? | Updates `api_keys.last_used_at`? | Failure contract |
| --- | --- | --- | --- |
| `apiKeyAuth` | Yes | Yes | Throws 401 via Elysia derive |
| `device-repos/auth` | Yes | No | Throws 401 via Elysia derive |
| MCP API key | Yes | Yes | 401 with OAuth `WWW-Authenticate` metadata |
| WS API key | No | No | WebSocket close `4001` |
| `jwtAuth` | No | N/A | Throws 401 via Elysia derive |
| MCP authorize JWT | No | N/A | Redirects to `/auth/github` |
| WS cookie/query JWT | No | N/A | WebSocket close `4001` |

Open decision for step 2: whether to preserve `last_used_at` differences exactly or normalize them as a tested bug fix.

## 1.2 `user_repos` Read Checks

### Direct Cross-User Read Gates

| Surface | Location | Current behavior |
| --- | --- | --- |
| Session detail/events | `apps/server/src/sessions/access.ts:16` | Loads a session by ID. Own sessions pass; cross-user sessions require caller row in `user_repos` for the session repo. Missing or unauthorized both become null so route returns 404. |
| Feed | `apps/server/src/social/routes.ts:20` | Reads caller repo IDs from `user_repos`, fetches sessions in those repos, then applies optional user/repo filters in memory. |
| Feed users | `apps/server/src/social/routes.ts:151` | Computes peers as users with rows in any repo the caller has claimed. |
| User questions | `apps/server/src/social/routes.ts:225` | For peer reads, requires caller-target repo overlap; citation visibility is later enforced by `loadSessionCards`. |
| User dashboard target | `apps/server/src/user/dashboard.ts:140` | Self path uses caller's repo IDs. Peer path uses caller-target repo intersection; empty overlap returns `no_access`. |
| Repo overview access | `apps/server/src/repo/overview.ts:115` | Resolves repo by full name, then requires caller `user_repos` row for the repo or returns 403 `no_access`. |
| Repo overview active strip | `apps/server/src/repo/overview.ts:240` | Only includes session authors and PR authors who have `user_repos` rows for the repo. |
| Chat team activity | `apps/server/src/chat/tools.ts:105` | Starts from caller visible repo IDs, then computes visible peers and optional repo/login scopes. |
| Chat get_session | `apps/server/src/chat/tools.ts:384` | Loads session directly, then requires caller `user_repos` row for the session repo; returns an error message instead of HTTP status. |
| Chat cards | `apps/server/src/chat/cards.ts:21` | Hydrates cited session IDs after filtering by caller visible repo IDs. Preserves input order and silently drops invisible or unknown IDs. |
| Presence read | `apps/server/src/presence/routes.ts:89` | Peer set is self plus any user sharing a claimed repo with caller. |
| WebSocket subscribe | `apps/server/src/ws/handler.ts:43` | On open, subscribes user to every repo channel from their `user_repos` rows. |

### Repo Ownership Inputs That Also Use `user_repos`

| Surface | Location | Current behavior |
| --- | --- | --- |
| Device repo registration | `apps/server/src/user/routes.ts:180` | Accepts repo paths/exclusions only when repo ID or full name resolves inside caller's `user_repos`. |
| Session repo matching | `apps/server/src/social/github-sync.ts:89` | Matches local paths/cwd/project against repos claimed by the user, respecting device exclusions. |
| Self PR ingest | `apps/server/src/social/pr-ingest-routes.ts:44` | Accepts PR metadata only for repos claimed by the caller; unknown or unclaimed repos count as `unknownRepos`. |
| PR poller backfill | `apps/server/src/social/pr-poller.ts:180` | Backfills open PRs for repos claimed by at least one user with a decryptable OAuth token. |

Repeated query shapes worth naming in step 3:

- `visibleRepoIdsForUser(userId)`
- `visibleReposForUser(userId)`
- `visiblePeerIdsForUser(userId)`
- `repoIdsSharedByUsers(callerId, targetId)`
- `canReadRepo(callerId, repoId)`
- `loadAccessibleSession(callerId, sessionId)`

## 1.3 Session And PR Read/Write Shapes

### Session Read Model

| Surface | Location | Current behavior |
| --- | --- | --- |
| Snapshot core | `apps/server/src/sessions/snapshot.ts:70`, `apps/server/src/sessions/snapshot.ts:88` | `toSnapshot` and `buildSnapshot` convert session row + heartbeat + insights + optional PR into the public snapshot shape. |
| Insight batch read | `apps/server/src/sessions/snapshot.ts:227` | Loads summary and rolling-summary analyzer outputs for session IDs. |
| PR batch read for sessions | `apps/server/src/sessions/snapshot.ts:266` | Maps sessions to PRs by `(repo_id, branch)` and picks newest PR per pair. |
| Own sessions route | `apps/server/src/sessions/routes.ts:21` | Fetches own session rows, heartbeats, insights, PRs, builds snapshots, filters by state/project, sorts. |
| Session detail route | `apps/server/src/sessions/routes.ts:78` | Uses `loadAccessibleSession`, then loads heartbeat/insights/PR and returns `toSnapshot`. |
| Feed route | `apps/server/src/social/routes.ts:20` | Rebuilds the same heartbeat/user/repo/insight/PR hydration pipeline, then augments snapshot with `github_login`, `avatar_url`, `repo_full_name`. |
| Chat team activity | `apps/server/src/chat/tools.ts:105` | Uses `toSnapshot`, then builds compact teammate session summaries with truncated prompt, top files, current tool, and PR. |
| Chat get_session | `apps/server/src/chat/tools.ts:384` | Uses `toSnapshot`, then augments with user and repo display fields. |
| Chat citation cards | `apps/server/src/chat/cards.ts:21` | Builds compact cards with similar heartbeat/user/repo/insight hydration, but currently does not include PR enrichment. |
| Standup input | `apps/server/src/user/dashboard.ts:346` | Reads target sessions in visible repos and converts only the fields needed for standup prompt composition. |

Potential owner name for later: `sessions/read-model`, with small surfaces for full snapshots, compact cards, team-activity summaries, and standup session inputs.

### Pull Request Ownership

| Surface | Location | Current behavior |
| --- | --- | --- |
| Self PR ingest | `apps/server/src/social/pr-ingest-routes.ts:30` | `/v1/me/prs` upserts caller-authored PRs for caller-claimed repos. It updates title/url/state/author/updatedAt but intentionally does not clobber `headRef` on conflict. |
| PR event poller | `apps/server/src/social/pr-poller.ts:310` | `persistPrFromEvent` upserts PR event state, including authoritative `headRef`, and publishes `session_updated` to matching `(repo, branch)` sessions. |
| Open PR backfill | `apps/server/src/social/pr-poller.ts:215` | Fetches open PRs per claimed repo, upserts them with `headRef`, and publishes `session_updated` to matching sessions. |
| PR activity fanout | `apps/server/src/social/pr-poller.ts:387`, `apps/server/src/social/pr-poller.ts:408` | Converts opened/reopened/merged events to `pr_activity` and publishes to claimed repo channel. |
| Session PR enrichment | `apps/server/src/sessions/snapshot.ts:266` | Reads PRs for sessions by `(repo_id, branch)`. Shared by sessions, feed, and chat tools. |
| Repo overview PR read | `apps/server/src/repo/overview.ts:194` | Reads recent PRs for a repo and maps to `ProjectPr`; also uses PR authors in active-person strip. |
| User dashboard PR read | `apps/server/src/user/dashboard.ts:189`, `apps/server/src/user/dashboard.ts:346` | Reads target-authored PRs in caller-visible repos for `/prs` and standup prompt input. |

Potential owner name for later: `pull-requests`, with separate methods for ingest upsert, event/backfill upsert, session enrichment, repo overview summaries, and user-authored recent PRs.

## 1.4 Focused Tests Identified

### Existing Characterization Coverage

| Area | Existing tests |
| --- | --- |
| API-key route auth | `apps/server/test/managed-agent-sessions.test.ts:65` rejects missing/invalid API keys. `apps/server/test/presence.test.ts:92` and `apps/server/test/user-location.test.ts:77` cover no-key rejection on `/v1` presence/location. `apps/server/test/integration.test.ts:135` covers setup-token exchange and API-key use. |
| MCP auth | `apps/server/test/mcp.test.ts:129` covers missing/invalid bearer challenges, valid device API key, valid MCP OAuth token, expired/revoked/wrong-resource/insufficient-scope OAuth token, per-user quota, and session ownership. |
| WebSocket auth shape | `apps/server/test/ws-auth.test.ts:4` covers cookie-origin guard. `apps/server/test/integration.test.ts:347` covers API-key query token connecting and receiving shared-repo updates. |
| Repo visibility | `apps/server/test/integration.test.ts:453` covers feed visibility. `apps/server/test/integration.test.ts:495` and `apps/server/test/integration.test.ts:505` cover session detail/events leakage. `apps/server/test/chat.test.ts:239`, `apps/server/test/chat.test.ts:544`, `apps/server/test/chat.test.ts:575`, and `apps/server/test/chat.test.ts:838` cover chat-team, chat-session, citation-card, and questions gates. `apps/server/test/presence.test.ts:153` and `apps/server/test/user-location.test.ts:154` cover presence/location no-leak behavior. |
| Session read shapes | `apps/server/test/upload.test.ts:308` and `apps/server/test/upload.test.ts:474` cover ingested session aggregate shape. `apps/server/test/chat.test.ts:575` covers compact card shape and visibility. `apps/server/test/chat.test.ts:636` and `apps/server/test/chat.test.ts:647` cover PR enrichment in team activity and get-session. |
| PR ingest/poller | `apps/server/test/pr-ingest.test.ts:53` covers self PR ingest accepting only caller-claimed repos. `apps/server/test/pr-poller.test.ts:32` covers `toPrMessage` mapping. `apps/server/test/repo-overview.test.ts:16` covers project-overview PR fingerprinting. |

### Test Gaps To Close Before Extraction

- Auth lookup: no direct matrix test for `api_keys.last_used_at` across `apiKeyAuth`, `device-repos/auth`, MCP API-key auth, and WS query-token auth. This gap matters because current behavior differs intentionally or accidentally.
- Auth lookup: WebSocket API-key/JWT failure and freshness behavior is mostly integration-smoke coverage, not direct characterization of invalid/stale JWT, invalid API key, or revoked credentials.
- Repo visibility: `/api/repos/:owner/:name/overview` has cache-fingerprint tests but no endpoint-level access test for 403 `no_access` versus 404 `not_found`.
- Repo visibility: `/api/users/:login/prs` and `/api/users/:login/standup` have prompt/fingerprint tests, but no endpoint-level coverage of self no-claimed-repos, peer overlap, or peer no-overlap behavior.
- Session read model: there is no dedicated test that locks the shared hydration pipeline for `/api/sessions` and `/api/feed`; existing integration checks mostly assert IDs and leakage.
- Pull request owner: `persistPrFromEvent` and `backfillOpenPrs` do not have DB-side tests for upsert fields, `headRef` behavior, or `session_updated` publish side effects.
- Pull request owner: no single test asserts the intentional difference between self PR ingest not clobbering `headRef` and poller/backfill being authoritative for `headRef`.

Recommended pre-step-2 test posture:

1. Add a small auth lookup characterization test around API-key `last_used_at` differences before changing lookup code.
2. Add endpoint tests for repo overview and dashboard visibility before moving `user_repos` gates behind a shared owner.
3. Add DB-side PR owner tests for ingest/event/backfill upsert semantics before extracting PR persistence.
4. Keep the existing chat/session/presence integration tests as regression coverage for the new shared visibility and session read-model helpers.
