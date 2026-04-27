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

---

## Harness readiness — sprint priorities (from 2026-04-25 audit)

Source: [`harness-readiness-audit-2026-04-25.md`](./harness-readiness-audit-2026-04-25.md). Audit verdict: ~60% harness-ready. Excellent doc scaffolding, gaps concentrated in enforcement, observability, and memory. Items 18–20 above are the Tier-3 enforcement complement to this section and remain deferred.

### Rung 1 — Legibility (batch fix) — ✅ shipped 2026-04-25

**21. ~~Resolve docs/ structural drift.~~** ✅ Shipped in single session 2026-04-25 across 10 new files + 5 updated files. The session went beyond the audit's minimum and also landed [`docs/CONVENTIONS.md`](../CONVENTIONS.md) + [`docs/templates/`](../templates/), closing the convention-template-protocol triangle.

- ✅ Reconciled desktop window count across [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`AGENTS.md`](../../AGENTS.md), [`README.md`](../../README.md). Six renderer windows + `trayPopup`/`dockPlaceholder` as auxiliary main-process chrome, explicitly distinguished in `ARCHITECTURE.md § UI / windows`.
- ✅ Added [`docs/README.md`](../README.md) — navigation map for `docs/` with two-tier structure made explicit.
- ✅ Added [`docs/CONVENTIONS.md`](../CONVENTIONS.md) — authoring bible: doc types, naming, two-tier hierarchy, per-workspace AGENTS.md rules, convention-template-protocol triangle, Tier 1–5 harness plan vocabulary.
- ✅ Added [`docs/templates/`](../templates/) — page shapes for design-doc, ADR, runbook, spec, plan, plus a templates README.
- ✅ Added [`docs/exec-plans/README.md`](./README.md) — `active/` vs `completed/` vs root convention; `.gitkeep` placeholders kept and now documented.
- ✅ Added [`docs/references/README.md`](../references/README.md) — `<library>-llms.txt` convention with file shape and add-a-reference workflow.
- ✅ Two-tier hierarchy kept (UPPERCASE root tier vs subdirectory tier) and documented in `CONVENTIONS.md § The two-tier docs hierarchy` and reflected in `design-docs/index.md § Cross-cutting models`. No file moves required.
- ✅ Filename convention: kebab-case for new docs; UPPERCASE reserved for the three legacy cross-cutting top-level docs (`RELIABILITY.md`, `SECURITY.md`, `QUALITY_SCORE.md`); rule documented in `CONVENTIONS.md § Naming`.
- ✅ Per-workspace AGENTS.md: minimum skeleton (`Layout` + `Commands` + `Before committing`) defined in `CONVENTIONS.md`; intentional shape variance per workspace role documented; root [`AGENTS.md`](../../AGENTS.md) updated with the shape-variance note below the workspaces table.
- ✅ Root [`AGENTS.md`](../../AGENTS.md) and [`CLAUDE.md`](../../CLAUDE.md) wired to `docs/README.md` and `docs/CONVENTIONS.md` as primary docs entry points.

### Rung 2 — Enforcement (~1 day)

**22. `apps/server/eslint.config.js`.** Mirror [`apps/desktop/eslint.config.js`](../../apps/desktop/eslint.config.js). Minimum rules: Elysia plugin-name uniqueness, layering (no cross-app imports), ban `console.*` once pino lands. Closes the desktop-vs-server lint asymmetry. **See item 39 first.**

**23. `lefthook.yml` for pre-commit hooks.** Run `bun run typecheck && bun run test && bun run gen:db-schema:check` on pre-commit. 1:1 with the existing manual checklists in [`AGENTS.md`](../../AGENTS.md) and [`CLAUDE.md`](../../CLAUDE.md); no new behavior.

### Rung 3 — Observability (~1 day, highest leverage)

**24. Adopt pino structured logger.** Shared logger config (in `packages/shared` or new `packages/log`). Replace `console.log` / `console.error` in `apps/server/src/analyzers/scheduler.ts`, ingest paths, and ws bridge first; rest of codebase second. Why this rung is highest priority: slashtalk's product is "make Claude Code sessions legible" — a repo whose own runtime is operationally illegible to its agents undermines the product story.

**25. Wire Sentry (or equivalent) for unhandled errors.** Single hook on the server. Captures crashes the way the analyzer ingest pipeline cannot today.

### Rung 4 — Memory (~half day)

**26. Lift `AGENTS.md` recipes into `.claude/skills/*`.** Convert the five "Adding X" sections in [`apps/server/AGENTS.md`](../../apps/server/AGENTS.md) into discrete skill files (`add-route.md`, `add-llm-analyzer.md`, `add-db-column.md`, etc.). Reference from root `AGENTS.md`. Free leverage — prose is already written.

### Deferred

**27. Architectural-invariant tests in `apps/server/test/`.** Tests that enforce `core-beliefs.md` rules at runtime (e.g., "every cross-user route joins `user_repos`", "every Elysia plugin has a unique `name`"). Complements items 18–20 (CI grep checks).

**28. Desktop integration tests.** Window lifecycle, IPC, preload bridge. Current coverage is 3 unit tests for a multi-window Electron app.

**29. ADR backfill.** Convert durable decisions in [`core-beliefs.md`](../design-docs/core-beliefs.md) into per-decision ADR files with date + alternatives considered. Optional — `core-beliefs.md` already captures Why; ADRs add the "what we chose against."

**30. Runbooks for known failure modes.** Analyzer crash recovery, ingest backlog drain, schema migration rollback, etc. None exist today.

### Open question — decide before item 22

**39. Server-vs-desktop ESLint asymmetry — intentional or sequencing artifact?** [`apps/desktop`](../../apps/desktop/eslint.config.js) has ESLint; [`apps/server`](../../apps/server/) does not, despite server being the security-critical path. If intentional culture choice (human review preference), record it in `core-beliefs.md` and close item 22 as won't-do. If sequencing artifact, ship item 22.

---

## Multi-instance readiness — before we scale `apps/server` past one replica

The MCP transport keeps each session as a live `McpServer` + `WebStandardStreamableHTTPServerTransport` instance in process memory (`apps/server/src/mcp/session-pool.ts`). That is correct for the MCP spec — sessions are connections, not records — and a DB-backed session store would be a category error. But two adjacent pieces of state need to move to Redis before we run more than one server replica.

**40. Sticky routing on the `Mcp-Session-Id` header at the load balancer.** With multiple replicas, a request carrying a session ID can land on a replica that doesn't own it and gets a spec-correct but disruptive 404. The MCP TypeScript SDK assumes sticky routing ([typescript-sdk #330](https://github.com/modelcontextprotocol/typescript-sdk/issues/330)). Implement at the LB (header- or cookie-based affinity); no code change in the server.

**41. Move `McpPresenceStore` onto `RedisBridge` pub/sub.** Today `apps/server/src/mcp/presence.ts` is an in-memory `Map`, so `get_team_activity` only sees teammates connected to the same replica as the caller. The presence events (`online` / `offline` / `activity`) are already shaped like a pub/sub stream — fan them through `apps/server/src/ws/redis-bridge.ts` and have each replica subscribe. Soft-fail contract from [`core-beliefs #7`](../design-docs/core-beliefs.md#7-redis-publishing-is-soft-fail) applies.

**42. SSE resumability via `EventStore`.** The MCP spec defines an `EventStore` hook so reconnecting clients can replay events with `Last-Event-ID`. We don't pass one. Only matters when we ship a tool that streams progress over a long-lived SSE; today's tools are short request/response. Pick this up the first time we add a streaming tool, not before.

---

## Sprint sequencing

Three days moves the repo from ~60% to ~90% harness-ready by the audit's checklist:

| Day  | Items                                    | Status                                                                                   |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | 24 (pino) + 25 (Sentry)                  | pending                                                                                  |
| 2 am | 23 (lefthook)                            | pending                                                                                  |
| 2 pm | 22 (server lint, after item 39 decision) | pending                                                                                  |
| 3 am | 26 (skills)                              | pending                                                                                  |
| 3 pm | 21 (Legibility batch)                    | ✅ shipped 2026-04-25 (went beyond audit scope: also landed CONVENTIONS.md + templates/) |
