# AGENTS.md

Slashtalk is a floating presence feed for Claude Code / Codex sessions. Avatars of teammates who share a GitHub repo with you; hover to peek at their live sessions (prompt, files, tokens, LLM-generated title).

This file is the **map** — start here, then follow links. Deep content lives in [`docs/`](docs/) and per-workspace `AGENTS.md` files.

## Start here

- [`docs/README.md`](docs/README.md) — **navigation map for `docs/`** (read first to find anything else)
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — authoring bible: doc types, naming, the convention-template-protocol triangle, when to write what
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — domain map (ingest, sessions, analyzers, ws, …)
- [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md) — rules that can't be broken
- [`docs/RELIABILITY.md`](docs/RELIABILITY.md) — ingest resume, heartbeat state machine, Redis soft-fail
- [`docs/SECURITY.md`](docs/SECURITY.md) — tokens, encryption, PII surface
- [`docs/QUALITY_SCORE.md`](docs/QUALITY_SCORE.md) — per-domain health grades
- [`docs/generated/db-schema.md`](docs/generated/db-schema.md) — auto-generated DB schema (run `bun run gen:db-schema` in `apps/server/` to refresh)
- [`docs/product-specs/`](docs/product-specs/) — backend + upload specs
- [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md) — known gaps + harness rollout plan
- [`docs/references/`](docs/references/) — 3rd-party library notes (Elysia, Drizzle, ioredis, Electron, Anthropic SDK)
- [`docs/templates/`](docs/templates/) — page shapes for every doc type

## Load-bearing memories

Rules live in [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md); the list below is a pared-down memory aid for the ones most often broken. Violating one causes a visible regression or data loss. Tier 3 of the harness plan will convert each to a mechanical CI check; until then, honor manually.

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
11. **Identity is user OAuth; no GitHub App.** Every GitHub API call uses the calling user's decrypted token. No installation flow, no org-admin dependency. OAuth scope stays `read:user read:org`. Detail: [`core-beliefs #11`](docs/design-docs/core-beliefs.md#11-identity-is-user-oauth-no-github-app).
12. **Repo claims gate on org membership or personal namespace.** `POST /api/me/repos` accepts iff `owner` is in the caller's active orgs (`GET /user/memberships/orgs?state=active`) or `owner === user.githubLogin`. Else `403 no_access`. Detail: [`core-beliefs #12`](docs/design-docs/core-beliefs.md#12-repo-access-is-verified-not-asserted).
13. **`user_repos` is the only authorization for cross-user reads.** Feed, sessions, events, WS channels all gate on it. Any new cross-user surface must go through the same check. Detail: [`core-beliefs #13`](docs/design-docs/core-beliefs.md#13-user_repos-is-the-only-authorization-for-cross-user-reads).

## Workspaces

Bun workspace monorepo. **`bun` is the only supported package manager** ([core-beliefs #1](docs/design-docs/core-beliefs.md#1-bun-is-the-only-package-manager)). Version pinned in [`.tool-versions`](.tool-versions).

| Workspace                            | Map                                    | Purpose                                                               |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| [`apps/server`](apps/server)         | [AGENTS.md](apps/server/AGENTS.md)     | Elysia backend (auth, ingest, sessions, social, analyzers, ws)        |
| [`apps/desktop`](apps/desktop)       | [AGENTS.md](apps/desktop/AGENTS.md)    | Electron overlay, 6 renderer windows + tray/dock chrome               |
| [`apps/web`](apps/web)               | [AGENTS.md](apps/web/AGENTS.md)        | Installable React PWA served by the server under `/app/*`             |
| [`apps/landing`](apps/landing)       | [README.md](apps/landing/README.md)    | Marketing homepage (Astro + Tailwind) served by the server at `/`     |
| [`apps/blog`](apps/blog)             | [README.md](apps/blog/README.md)       | Public Astro marketing/blog site served by the server under `/blog/*` |
| [`packages/shared`](packages/shared) | [AGENTS.md](packages/shared/AGENTS.md) | Source-only TS types                                                  |

Per-workspace `AGENTS.md` shape varies intentionally by workspace role — server is recipe-heavy, desktop is design-system-heavy, and shared is constraint-heavy. The minimum every workspace AGENTS.md must include is `Layout` + `Commands` + `Before committing`. See [`docs/CONVENTIONS.md#per-workspace-agentsmd`](docs/CONVENTIONS.md#per-workspace-agentsmd).

## Route prefix encodes auth

| Prefix               | Auth                                                            | Used by                  |
| -------------------- | --------------------------------------------------------------- | ------------------------ |
| `/`                  | Public static; no auth                                          | Marketing homepage       |
| `/app/*`             | Static shell; data fetched via `/api/*` cookie auth             | Web PWA                  |
| `/blog`, `/blog/*`   | Public static; no auth                                          | Blog site                |
| `/v1/*`              | `apiKeyAuth` (Bearer token, SHA-256 compared)                   | Desktop + CLI            |
| `/mcp`               | MCP OAuth access token; device API key for local proxy / legacy | MCP HTTP clients         |
| `/auth/*` + `/api/*` | `jwtAuth` (httpOnly `session` cookie or `Cookie:` header)       | Browser + desktop cookie |
| `/ws`                | httpOnly `session` cookie, else `?token=` JWT/API key           | Web + desktop            |

Mixing is a rule violation. Root `/mcp` is the explicit MCP resource-server exception because MCP protocol versioning happens in the initialize handshake — see [core-beliefs #2](docs/design-docs/core-beliefs.md#2-route-prefix-encodes-auth).

## Commands from repo root

```sh
bun run dev                                    # start server + desktop for local development
bun run dev:web                                # start only the web PWA Vite dev server
bun run dev:blog                               # start only the blog Astro dev server (localhost:4321/blog)
bun run dev:landing                            # start only the landing Astro dev server (localhost:4321)
bun install                                    # install all workspaces
bun --filter @slashtalk/server <script>
bun --filter @slashtalk/electron <script>
bun --filter @slashtalk/web <script>
bun --filter @slashtalk/blog <script>
bun --filter @slashtalk/landing <script>
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

## Changesets

Any change that is **user-visible** or **material** to a published package — bug fixes, new features, behavior changes, packaging or auto-update changes, dependency bumps that affect runtime — needs a changeset so it lands in the next `chore: version packages` cut and ships in the next desktop build.

```sh
bunx changeset                       # interactive — pick package(s) + bump type
# or write the file directly:
# .changeset/<kebab-slug>.md
# ---
# "@slashtalk/electron": patch
# ---
#
# One-paragraph user-facing description of what changed and why it matters.
```

Today only `@slashtalk/electron` is versioned ([`.changeset/config.json`](.changeset/config.json) ignores `server`/`web`/`blog`/`landing`/`shared`), so most changesets target it. Use `patch` for fixes, `minor` for new features, `major` for breaking changes. Skip the changeset only for things that don't affect behavior — pure docs, tests, internal refactors with no observable change, or edits to ignored workspaces.

## Adding something common

- **Route plugin** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-a-route-plugin)
- **LLM analyzer** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-an-llm-analyzer)
- **DB column/table** → [`apps/server/AGENTS.md`](apps/server/AGENTS.md#adding-a-database-column-or-table)
- **BrowserWindow or IPC** → [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)
- **Web PWA route/service worker** → [`apps/web/AGENTS.md`](apps/web/AGENTS.md)
- **Landing page or copy change** → [`apps/landing/README.md`](apps/landing/README.md)
- **Blog page or copy change** → [`apps/blog/README.md`](apps/blog/README.md)
- **Shared type** → [`packages/shared/AGENTS.md`](packages/shared/AGENTS.md#adding-a-new-type)

## Keeping this map current

When you change: a workspace, auth scheme, ingest protocol, Redis channel design, analyzer plugin contract, or add a BrowserWindow — update the relevant `AGENTS.md` and the affected file under `docs/` in the same commit. A subtly wrong map is worse than a missing one.

`CLAUDE.md` is a symlink to this file; Codex and other agents find `AGENTS.md` by convention.
