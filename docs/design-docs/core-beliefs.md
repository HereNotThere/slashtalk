# Core beliefs

The load-bearing rules for this codebase. Each is stated with **Why** (why we care) and **How to apply** (when/where the rule bites). Tier 3 of the harness plan will convert each into a mechanical check in `scripts/check-invariants.ts`; until then, treat violations as PR-blocking.

---

## 1. Bun is the only package manager

**Why.** The monorepo is a Bun workspace. `bun.lock` is committed; `npm`/`pnpm`/`yarn` produce a different lockfile and drift.

**How to apply.** `bun install` at the repo root, `bun run <script>` inside a workspace, `bun --filter <name> <script>` for targeted runs. Never add `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`.

---

## 2. Route prefix encodes auth

**Why.** The two auth plugins (`jwtAuth`, `apiKeyAuth`) derive different context shapes. Mixing them on a single route makes 401s unpredictable and blurs the trust boundary.

**How to apply.**

- `/v1/*` → `apiKeyAuth` only (desktop/CLI clients).
- `/auth/*` + `/api/*` → `jwtAuth` only (browser / desktop cookie).
- `/mcp` → explicit MCP resource-server exception. It accepts MCP OAuth access tokens for direct MCP clients and Slashtalk device API keys for the desktop-local proxy / legacy bridge; do not bury MCP under `/v1` because MCP protocol versioning is negotiated in the initialize handshake.
- WS `/ws` accepts either via `?token=...` (tries JWT first, then API key).

A new auth scheme gets its own plugin in `apps/server/src/auth/middleware.ts`, not an overload.

---

## 3. Elysia plugin names are required and globally unique

**Why.** Elysia dedups plugins by `name`. Missing or duplicate names cause silent re-mounts or skipped handlers.

**How to apply.** Every route plugin is a factory `(db, redis?) => new Elysia({ name: "<area>", prefix: "/<prefix>" })…`. Preserve `name` on edits; never duplicate across files.

---

## 4. Drizzle migrations are append-only

**Why.** Hand-editing `_journal.json` or resequencing committed migrations breaks fresh bootstraps and diverges the `when` field. Existing incident captured in memory `feedback_drizzle_journal_when`.

**How to apply.**

1. Edit `apps/server/src/db/schema.ts`.
2. `bun run db:generate` from `apps/server/`.
3. Review generated SQL; for renames/destructive ops, regenerate as `--custom`.
4. `bun run db:migrate` to apply.
5. Commit schema + generated SQL + journal updates as one commit.
6. **Never** hand-edit `apps/server/drizzle/meta/_journal.json` or `*_snapshot.json`.
7. **Never** rename or resequence committed migration files.
8. To fix a broken migration, add a corrective migration.

---

## 5. `@slashtalk/shared` is source-only

**Why.** Runtime values (`SessionState`, `SOURCES`, `EVENT_KINDS`) work because the package exposes `src/index.ts` directly via `main`/`types` + tsconfig `paths`. Adding a build step or `dist/` would break this silently.

**How to apply.** Import `@slashtalk/shared` or `@slashtalk/shared/*`. Never reference a `dist/` path. Never add runtime exports that depend on a compile step. See `packages/shared/package.json` — `main` and `types` point at `src/index.ts`.

---

## 6. Strict-tracking gate in the desktop uploader

**Why.** Sessions whose `cwd` does not resolve under a claimed local repo must never ship — otherwise arbitrary working directories leak into the shared feed. Reviewed, validated, load-bearing. Memory: `feedback_strict_tracking`.

**How to apply.** [`apps/desktop/src/main/uploader.ts`](../../apps/desktop/src/main/uploader.ts) calls `localRepos.isPathTracked(cwd)` before any upload or heartbeat for each session. Do not loosen or skip this check without explicit user direction recorded on the PR.

---

## 7. Redis publishing is soft-fail

**Why.** `RedisBridge` swallows pub/sub errors so the HTTP API stays up when Redis is down or flaky. A raw `await redis.publish(...)` bubbles up and 500s the request.

**How to apply.** Call `redis.publish(channel, msg)` through [`apps/server/src/ws/redis-bridge.ts`](../../apps/server/src/ws/redis-bridge.ts). Do not `await redis.publish(...)` in routes or aggregators.

---

## 8. Latest Claude model IDs

**Why.** Pricing tables, capability assumptions, and tool-use behavior are pinned to specific revisions. Drift to older or unreleased IDs causes silent billing spikes or runtime 404s.

**How to apply.** Allowed IDs: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`. Update the pricing table in [`apps/server/src/analyzers/llm.ts`](../../apps/server/src/analyzers/llm.ts) when adding a new ID.

---

## 9. TypeScript strict everywhere

**Why.** Shape drift between server, desktop, and shared is caught by the compiler. Loosening strictness swallows those errors.

**How to apply.** `strict: true` in every tsconfig. `// @ts-ignore` / `// @ts-expect-error` only with a one-line comment explaining why and what event would let it be removed.

---

## 10. Small, focused PRs

**Why.** Agent-to-agent review relies on diffs that can be read end-to-end in under a minute. Large PRs compound review latency quadratically.

**How to apply.** Aim for <300 changed lines. Split refactors from feature work. Split docs-only changes from code changes.

---

## 11. Identity is user OAuth; no GitHub App.

**Why.** Requiring an admin-installed GitHub App gates adoption on someone other than the end user — exactly the friction the product positioning rejects. slashtalk's promise is that any signed-in user can start with normal GitHub OAuth and no broad repo scope. Private repo _contents_ are never read by the server; cross-user visibility is gated on GitHub org membership instead, which `read:org` already covers.

**How to apply.**

- OAuth scope stays `read:user read:org` ([docs/SECURITY.md § OAuth scope](../SECURITY.md)).
- Identity, org picker, public repo metadata, and the claim gate all use the calling user's OAuth token via [`fetchUserGithubToken`](../../apps/server/src/user/github-helpers.ts).
- Do not request OAuth `repo` scope. Do not re-introduce a GitHub App without an explicit core-beliefs revision and a SECURITY.md rewrite.
- The `users.github_app_*` columns persist in the schema as orphan storage from a previous App-fallback iteration; do not write to them.

---

## 12. Repo access is verified, not asserted.

**Why.** `user_repos` is the single authorization source for the feed, session, event, and WebSocket channels. A row must represent a stable, GitHub-attested property of the caller — otherwise every downstream check becomes a sieve. A pre-gate bug in [PR #85](https://github.com/HereNotThere/slashtalk/pull/85) let any JWT holder claim any `owner/name` and inherit the real collaborators' visibility.

**How to apply.**

- [`POST /api/me/repos`](../../apps/server/src/user/claim.ts) accepts a claim iff (a) the repo's `owner` is in the caller's active org memberships from `GET /user/memberships/orgs?state=active` (case-insensitive), or (b) `owner === user.githubLogin`. Anything else is `403 no_access`. Never fall back to "accept."
- The org-membership check fails closed: `401` triggers the global credentials cascade and returns `401 token_expired`; `403`, 5xx, or network failure returns `502 upstream_unavailable` without invalidating the session.
- Org membership is verified, not GitHub repo-level ACL. This is a deliberate trust-model choice; see [docs/SECURITY.md § Repo-claim verification](../SECURITY.md) for the trust-boundary disclosure.
- Never hand-insert `user_repos` rows from migrations, seed scripts, or other routes; go through the same gate (or run [`scripts/reclassify-by-org.ts`](../../apps/server/scripts/reclassify-by-org.ts) afterward to catch drift).
- A per-user rate limit on the claim endpoint is a generic abuse guard.

---

## 13. `user_repos` is the only authorization for cross-user reads.

**Why.** Sessions, events, and WS fan-out channels (`repo:<id>`) all assume that a `user_repos` row = "this user is a legitimate reader of this repo." Any read path that doesn't join through `user_repos` silently leaks one user's data to another.

**How to apply.**

- Every route that returns another user's data — [`/api/feed`](../../apps/server/src/social/routes.ts), `/api/feed?user=` / `?repo=`, [`/api/feed/users`](../../apps/server/src/social/routes.ts), [`/api/session/:id`](../../apps/server/src/sessions/routes.ts), `/api/session/:id/events` — joins on or filters by `user_repos` scoped to the caller.
- The WS channel subscription list in [`ws/handler.ts`](../../apps/server/src/ws/handler.ts) is built from `user_repos` only.
- When adding a new cross-user surface, trace the authorization path back to `user_repos` before merging.
