## Major — Core logic the server is supposed to compute

**1. ~~Session aggregate computation on ingest~~** ✅ `ingest/aggregator.ts`
Processes each event to update: counters, token accounting with pricing table, model/version/branch/cwd, timestamps, title, in_turn/last_boundary_ts, outstanding_tools, last_user_prompt, file tracking, tool names, queued commands, recent_events ring buffer.

**2. ~~GitHub repo sync~~** ✅ `social/github-sync.ts`
Paginates GitHub API, filters to push+ permission, upserts repos + user_repos, deletes stale rows. Auto-runs on first login.

**3. ~~Repo ↔ session matching~~** ✅ `social/github-sync.ts` + `ingest/routes.ts`
Matches session cwd path components against user's known repos (full_name then name). Runs during ingest when session has no repo_id.

**4. ~~Snapshot response shape~~** ✅ `sessions/snapshot.ts`
Transforms DB rows into spec-compliant JSON: `id`, `idleS`, `durationS`, `tokens` (nested), `cost` (float), `cacheHitRate`, `burnPerMin`, `currentTool`, filtered `queued`, `recent`, `topFiles*` as sorted pairs.

**5. ~~Feed ordering~~** ✅ `sessions/snapshot.ts`
`sortByStateThenTime()` groups by state priority (busy→active→idle→recent→ended), then by lastTs desc.

**6. ~~Feed augmentation~~** ✅ `social/routes.ts`
`/api/feed` joins users + repos to include `github_login`, `avatar_url`, `repo_full_name`.

---

## Medium — Missing endpoints and features

**7. ~~Heartbeat → Redis publish~~** ✅ `ingest/routes.ts`
Computes state before and after heartbeat upsert; publishes `session_updated` on state change.

**8. ~~`GET /install.sh`~~** ✅ `app.ts` + `install/install.sh`
Serves static POSIX shell script with `Content-Type: text/plain`.

**9. ~~`POST /v1/devices/:id/repos`~~** ✅ `user/routes.ts`
`deviceReposRoutes` accepts `{ excludedRepoIds: number[] }`, manages `device_excluded_repos`.

**10. ~~Prefix hash validation~~** ✅ `ingest/routes.ts`
Checks existing prefixHash against incoming; resets offset on mismatch.

**11. `drizzle-typebox` integration** (backend.spec tech stack)
Listed as a dependency for auto-generating TypeBox schemas from Drizzle tables → OpenAPI. Currently route schemas are hand-written. Low priority — the OpenAPI spec is already generated from TypeBox route schemas.

---

## Minor — Polish and operational

**12. ~~Missing events index~~** ✅ `db/schema.ts`
Added `(user_id, project, ts DESC)` index on events table.

**13. ~~`/api/feed` query filters~~** ✅ `social/routes.ts`
`?user=<login>` and `?repo=<full_name>` filters implemented. `?state=` filter applied post-snapshot.

**14. ~~`/api/session/:id` access control for feed sessions~~** ✅ `sessions/routes.ts`
Session visible if owned by user OR user has access to the session's repo via user_repos.

**15. ~~`/auth/exchange` path mismatch~~** ✅ `auth/github.ts`
Split into `githubAuth` (prefix `/auth`) and `cliAuth` (prefix `/v1/auth`). Exchange endpoint now at `/v1/auth/exchange`.

**16. Frontend pages** (backend.spec §7)
Homepage/feed, session detail, settings, and login pages. Not yet implemented — backend API is complete.

**17. ~~Install script~~** ✅ `install/install.sh`
Token exchange, repo discovery, initial upload, watch mode with 5s poll, launchd (macOS) and systemd (Linux) service installation.

---

## Security invariants — Tier-3 CI check candidates

Scripted checks that would replace the human honor-system in [`docs/design-docs/core-beliefs.md`](../design-docs/core-beliefs.md) §§ 11-13 with mechanical guardrails. Tracked here until `scripts/check-invariants.ts` is wired into CI.

**18. CI check: no direct cross-user reads that skip `user_repos`.**
Grep every file under `apps/server/src/` that references `sessions`, `events`, or a `repo:<id>` Redis channel subscription and fail if the handler doesn't also touch `userRepos`. See [`core-beliefs #13`](../design-docs/core-beliefs.md#13-user_repos-is-the-only-authorization-for-cross-user-reads).

**19. CI check: `POST /api/me/repos` always verifies.**
Parse the handler body and fail if a `user_repos` insert is reached without a `verifyRepoAccess` (or equivalent `GET /repos/:owner/:name`) call on the path. See [`core-beliefs #12`](../design-docs/core-beliefs.md#12-repo-access-is-verified-not-asserted).

**20. CI check: no GitHub App code paths.**
Grep the repo for `installation_id`, `"GitHub App"`, `/app/installations`, `X-GitHub-Installation-Id`, and fail on any match under `apps/server/src/`. See [`core-beliefs #11`](../design-docs/core-beliefs.md#11-identity-is-user-oauth-no-github-app).
