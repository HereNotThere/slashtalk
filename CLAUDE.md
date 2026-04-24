# CLAUDE.md

This file exists so Claude Code finds its bearings quickly. **The canonical map is [`AGENTS.md`](AGENTS.md) — read it first.** Codex and other agents also find that file by convention.

This file is kept short so it doesn't crowd out the task, the code, and the relevant docs (per OpenAI's harness-engineering lesson that "context is a scarce resource; a giant instruction file becomes non-guidance"). Rules live in [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md); the list below is a pared-down memory aid for the ones most often broken.

## Load-bearing memories

Violating one of these causes a visible regression or data loss. Tier 3 of the harness plan will convert each to a mechanical CI check; until then, honor manually.

1. **Bun only.** No npm/pnpm/yarn. Version pinned in [`.tool-versions`](.tool-versions).
2. **Route prefix encodes auth.** `/v1/*` = API key, `/auth/*` + `/api/*` = JWT. Never mix on the same plugin. Detail: [`core-beliefs #2`](docs/design-docs/core-beliefs.md#2-route-prefix-encodes-auth).
3. **Elysia plugin `name` is required and globally unique.** Preserve on every edit.
4. **Drizzle migrations are append-only.** Never hand-edit `apps/server/drizzle/meta/_journal.json` or `*_snapshot.json`. Never resequence. Fix broken migrations with a corrective one. Memory: `feedback_drizzle_journal_when`.
5. **`@slashtalk/shared` is source-only.** No build step, no `dist/`.
6. **Strict-tracking gate in the desktop uploader.** [`localRepos.isPathTracked(cwd)`](apps/desktop/src/main/uploader.ts) runs before every upload/heartbeat. Don't loosen. Memory: `feedback_strict_tracking`.
7. **Redis publishing is soft-fail.** Never `await redis.publish(...)` outside [`apps/server/src/ws/redis-bridge.ts`](apps/server/src/ws/redis-bridge.ts).
8. **Latest Claude model IDs only:** `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`. Update pricing in [`apps/server/src/analyzers/llm.ts`](apps/server/src/analyzers/llm.ts) when adding.
9. **Run tests after server changes.** From `apps/server/`: `bun run typecheck && bun run test`. Fast (seconds). CI runs the same on every push — don't push a red typecheck.
10. **Refresh [`docs/generated/db-schema.md`](docs/generated/db-schema.md) when schema changes.** `bun run gen:db-schema` in `apps/server/`. CI will check.

## Where to go next

- [`AGENTS.md`](AGENTS.md) — project map + workspaces.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — domain map (ingest, sessions, analyzers, ws, …).
- [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md) — the full rule list with "why" and "how to apply" per rule.
- [`docs/RELIABILITY.md`](docs/RELIABILITY.md) — resume protocol, state machine, soft-fail contract.
- [`docs/SECURITY.md`](docs/SECURITY.md) — tokens, encryption, PII surface.
- [`apps/server/AGENTS.md`](apps/server/AGENTS.md) — recipes: add a route, analyzer, table, WS message.
- [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md) — windows, styling, packaging.
- [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md) — known gaps.

## Keeping the map current

When you change an invariant (auth model, ingest dedup key, Redis channel design, a BrowserWindow, the analyzer plugin contract, `@slashtalk/shared` consumption), update the relevant `AGENTS.md`, the affected `docs/` file, and this file in one commit. Prefer `AGENTS.md` / `docs/` as the source of truth — add to CLAUDE.md only when it's a memory-style rule an agent must read before touching code.
