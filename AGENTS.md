# AGENTS.md

Slashtalk is a floating presence feed for Claude Code / Codex sessions. Avatars of teammates who share a GitHub repo with you; hover to peek at their live sessions (prompt, files, tokens, LLM-generated title).

This file is the **map** — start here, then follow links. Deep content lives in [`docs/`](docs/) and per-workspace `AGENTS.md` files.

## Start here

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — domain map (ingest, sessions, analyzers, ws, …)
- [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md) — rules that can't be broken
- [`docs/RELIABILITY.md`](docs/RELIABILITY.md) — ingest resume, heartbeat state machine, Redis soft-fail
- [`docs/SECURITY.md`](docs/SECURITY.md) — tokens, encryption, PII surface
- [`docs/QUALITY_SCORE.md`](docs/QUALITY_SCORE.md) — per-domain health grades
- [`docs/generated/db-schema.md`](docs/generated/db-schema.md) — auto-generated DB schema (run `bun run gen:db-schema` in `apps/server/` to refresh)
- [`docs/product-specs/`](docs/product-specs/) — backend + upload specs
- [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md) — known gaps
- [`docs/references/`](docs/references/) — 3rd-party library notes (Elysia, Drizzle, ioredis, Electron, Anthropic SDK)

## Workspaces

Bun workspace monorepo. **`bun` is the only supported package manager** ([core-beliefs #1](docs/design-docs/core-beliefs.md#1-bun-is-the-only-package-manager)). Version pinned in [`.tool-versions`](.tool-versions).

| Workspace | Map | Purpose |
| --- | --- | --- |
| [`apps/server`](apps/server) | [AGENTS.md](apps/server/AGENTS.md) | Elysia backend (auth, ingest, sessions, social, analyzers, ws) |
| [`apps/desktop`](apps/desktop) | [AGENTS.md](apps/desktop/AGENTS.md) | Electron overlay, 7 BrowserWindows |
| [`apps/mcp`](apps/mcp) | [AGENTS.md](apps/mcp/AGENTS.md) | MCP server (being consolidated into `apps/server`) |
| [`packages/shared`](packages/shared) | [AGENTS.md](packages/shared/AGENTS.md) | Source-only TS types |

## Route prefix encodes auth

| Prefix | Auth | Used by |
| --- | --- | --- |
| `/v1/*` | `apiKeyAuth` (Bearer token, SHA-256 compared) | Desktop + CLI |
| `/auth/*` + `/api/*` | `jwtAuth` (httpOnly `session` cookie or `Cookie:` header) | Browser + desktop cookie |
| `/ws?token=…` | JWT, else API key | All clients |

Mixing is a rule violation — see [core-beliefs #2](docs/design-docs/core-beliefs.md#2-route-prefix-encodes-auth).

## Commands from repo root

```sh
bun run dev                                    # start server + MCP + desktop for local development
bun install                                    # install all workspaces
bun --filter @slashtalk/server <script>
bun --filter @slashtalk/electron <script>
bun --filter @slashtalk/mcp <script>
bun --filter @slashtalk/shared <script>
```

## Before committing

In each touched workspace:

```sh
bun run typecheck
bun run test     # apps/server + where applicable
bun run lint     # apps/desktop today; apps/server forthcoming (Tier 2)
```

If you touched `apps/server/src/db/schema.ts`, also run `bun run gen:db-schema` to refresh [`docs/generated/db-schema.md`](docs/generated/db-schema.md).

## Adding something common

- **Route plugin** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-a-route-plugin)
- **LLM analyzer** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-an-llm-analyzer)
- **DB column/table** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-a-database-column-or-table)
- **BrowserWindow or IPC** → [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)
- **Shared type** → [`packages/shared/AGENTS.md`](packages/shared/AGENTS.md#adding-a-new-type)

## Keeping this map current

When you change: a workspace, auth scheme, ingest protocol, Redis channel design, analyzer plugin contract, or add a BrowserWindow — update the relevant `AGENTS.md` and the affected file under `docs/` in the same commit. A subtly wrong map is worse than a missing one.

CLAUDE.md is now a thin redirect to this file plus the load-bearing memories; Codex and other agents find AGENTS.md by convention.
