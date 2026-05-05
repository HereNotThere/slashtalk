## 1. Prepare The Move

- [ ] 1.1 Inventory current `apps/server/src` imports and confirm the final moved-path map from `design.md`.
- [ ] 1.2 Identify any route plugin `name` values before moving files so they can be preserved exactly.
- [ ] 1.3 Confirm no `packages/shared` files, exports, or imports need to change for this server-only reorganization.

## 2. Rehome Platform, Static, And Utility Modules

- [ ] 2.1 Move `config.ts`, `db/`, and Redis/WebSocket infrastructure into the selected `platform/` layout.
- [ ] 2.2 Move static-file serving modules into `static/` while preserving `/app/*`, `/blog/*`, `/`, asset, and install-script behavior.
- [ ] 2.3 Move small server-only helpers into `lib/` and update imports.
- [ ] 2.4 Update `apps/server/drizzle.config.ts` and `apps/server/scripts/gen-db-schema.ts` for the new schema path.

## 3. Rehome Product Domains And Jobs

- [ ] 3.1 Move stable product domains into `domains/` without changing exported route factory behavior.
- [ ] 3.2 Split `social` into the chosen `domains/feed`, `domains/repos`, and `jobs/pr-poller` homes while preserving existing interfaces.
- [ ] 3.3 Move `managed-agent-sessions` into the chosen agents domain path.
- [ ] 3.4 Move analyzer scheduler code into `jobs/analyzers` unless implementation confirms a better split is needed.
- [ ] 3.5 Update `app.ts` and `index.ts` imports so server composition and background startup remain unchanged.

## 4. Update Tests, Scripts, And Docs

- [ ] 4.1 Update server tests and helpers for moved imports and migration folder references.
- [ ] 4.2 Update root `AGENTS.md`, `ARCHITECTURE.md`, and `apps/server/AGENTS.md` with the new server layout.
- [ ] 4.3 Update DB workflow docs and Drizzle reference docs for the new schema path.
- [ ] 4.4 Regenerate or check `docs/generated/db-schema.md` so its source path text remains current.

## 5. Verify

- [ ] 5.1 Run `bun run typecheck` from `apps/server/`.
- [ ] 5.2 Run `bun run test` from `apps/server/`.
- [ ] 5.3 Run `bun run gen:db-schema:check` from `apps/server/`.
- [ ] 5.4 Inspect `git diff --stat` and moved-file diffs to confirm the change is source organization only.
