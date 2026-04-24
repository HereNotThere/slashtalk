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
