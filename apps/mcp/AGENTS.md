# apps/mcp (`@slashtalk/mcp`)

MCP server + managed-agent session ingest. Standalone Bun service that sits alongside `@slashtalk/server`.

> **Being consolidated into `apps/server`.** The consolidation phases are tracked in this workspace's [`README.md`](README.md) and in the slashtalk merge plan. **New work should land in [`apps/server`](../server/) when feasible**; mirror here only if MCP-specific.

## What's here

- MCP tools over streamable-HTTP transport at `/mcp` (currently `share_workspace`).
- Managed-agent session upserts at `PUT /v1/agent_sessions` (and `GET`) — used by the slashtalk desktop app.
- Presence endpoints (`/presence`, `/presence/stream`) and a chatheads-era GitHub OAuth surface used by the desktop loopback flow. Auth will unify with `@slashtalk/server` per the README's Phase 6.

Migrations live in [`migrations/`](migrations/) and auto-apply on boot (bun:sql + a small runner, not Drizzle). When consolidated, they move into [`apps/server`](../server/)'s Drizzle schema.

## Commands

Run from `apps/mcp/`:

```sh
bun install        # repo-root `bun install` also suffices
bun run dev        # --watch
bun run typecheck
```

## Environment

Same as `apps/server` plus legacy names: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TOKEN_SECRET`, `PUBLIC_URL`, `DATABASE_URL`. See [`README.md`](README.md) for details.

## Guardrails

The same core beliefs apply ([`../../docs/design-docs/core-beliefs.md`](../../docs/design-docs/core-beliefs.md)) — Bun only, latest model IDs, no `await redis.publish(...)` outside a bridge, etc.

**Do not deepen the divergence from `apps/server`**: do not add schema changes that will need to be ported later, do not add a second auth model, and do not add new consumers of the legacy token format without discussing with the maintainer first.

## Before committing

```sh
bun run typecheck
```

If you change MCP tool signatures consumed by the desktop app, run [`apps/desktop`](../desktop/)'s typecheck in the same PR.
