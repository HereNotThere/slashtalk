# @slashtalk/mcp

MCP server + managed-agent ingest. Runs as a standalone Bun service that
sits alongside `@slashtalk/server`. Two audiences talk to it:

- **Claude Code / Claude Desktop / claude.ai** connect to `/mcp` over
  MCP's streamable HTTP transport. Registered tools currently: `share_workspace`.
- **The slashtalk desktop app** upserts managed-agent session pointers +
  client-generated summaries to `/v1/agent_sessions` (`PUT` / `GET`).

Also hosts presence (`/presence`, `/presence/stream`) and the chatheads-
era GitHub OAuth surface used by the desktop loopback flow. Auth will be
unified with `@slashtalk/server` in a later pass (see
`chatheads-team-two/merge-into-slashtalk-plan.md`, Phase 6).

## Local dev

```bash
cd apps/mcp
bun install
bun dev            # runs with --watch
```

Needs a Postgres. For now, reuses the `chatheads_dev` DB via Postgres.app:

```
DATABASE_URL=postgres://<you>@localhost:5432/chatheads_dev
```

Migrations auto-apply on boot (bun:sql + a small runner, not Drizzle).
See `migrations/`. When we consolidate with slashtalk's Drizzle schema,
these move into `apps/server`'s migration set.

Other env vars — same as the chatheads backend was before the move:
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TOKEN_SECRET`, `PUBLIC_URL`.

## Install into Claude Code

The desktop app's `installMcp.ts` writes this server into
`~/.claude.json` automatically on first launch. Manual install for
development:

```bash
claude mcp add slashtalk-mcp --transport http http://localhost:3000/mcp
```

Or edit `~/.claude.json` directly under `mcpServers`.
