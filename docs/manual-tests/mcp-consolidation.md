# MCP Consolidation Manual Test

Phase 1 verifies that `apps/server` owns root `/mcp` and `/v1/managed-agent-sessions` with the existing Slashtalk device API key. The consolidated MCP route advertises the team-activity tools used by Claude Code / Codex clients.

## Start Services

From the repo root:

```sh
docker run -d --name slashtalk-dev-pg \
  -e POSTGRES_USER=slashtalk \
  -e POSTGRES_PASSWORD=slashtalk \
  -e POSTGRES_DB=slashtalk \
  -p 5432:5432 postgres:16

docker run -d --name slashtalk-dev-redis -p 6379:6379 redis:7

cd apps/server
DATABASE_URL=postgres://slashtalk:slashtalk@localhost:5432/slashtalk \
REDIS_URL=redis://localhost:6379 \
GITHUB_CLIENT_ID=<github-oauth-client-id> \
GITHUB_CLIENT_SECRET=<github-oauth-client-secret> \
JWT_SECRET=<32-plus-char-secret> \
ENCRYPTION_KEY=<64-char-hex-key> \
BASE_URL=http://localhost:10000 \
bun run db:migrate

DATABASE_URL=postgres://slashtalk:slashtalk@localhost:5432/slashtalk \
REDIS_URL=redis://localhost:6379 \
GITHUB_CLIENT_ID=<github-oauth-client-id> \
GITHUB_CLIENT_SECRET=<github-oauth-client-secret> \
JWT_SECRET=<32-plus-char-secret> \
ENCRYPTION_KEY=<64-char-hex-key> \
BASE_URL=http://localhost:10000 \
bun run dev
```

In another terminal, run the desktop against the same server and sign in:

```sh
cat > apps/desktop/.env <<'EOF'
MAIN_VITE_SLASHTALK_API_URL=http://localhost:10000
EOF

bun run dev:desktop
```

## Get A Device API Key

After signing in through the desktop, install MCP for Claude Code from the app. Confirm `~/.claude.json` contains only the `slashtalk-mcp` entry you expect:

```json
{
  "mcpServers": {
    "slashtalk-mcp": {
      "type": "http",
      "url": "http://localhost:10000/mcp",
      "headers": {
        "Authorization": "Bearer <device-api-key>"
      }
    }
  }
}
```

If you are testing with curl instead of Claude Code, use the same bearer value.

## Verify `/mcp`

Initialize an MCP session:

```sh
curl -i http://localhost:10000/mcp \
  -H 'Authorization: Bearer <device-api-key>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"initialize",
    "params":{
      "protocolVersion":"2025-11-25",
      "capabilities":{},
      "clientInfo":{"name":"manual-curl","version":"0.0.0"}
    }
  }'
```

Expected:

- HTTP `200`.
- Response includes `mcp-session-id`.
- Server log includes `mcp_session_opened`.

Use the returned `mcp-session-id` to list tools:

```sh
curl -i http://localhost:10000/mcp \
  -H 'Authorization: Bearer <device-api-key>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <mcp-session-id>' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Expected:

- HTTP `200`.
- Tool list includes `get_team_activity` and `get_session`.
- `share_workspace` is not present.

Call the team activity tool:

```sh
curl -i http://localhost:10000/mcp \
  -H 'Authorization: Bearer <device-api-key>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <mcp-session-id>' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_team_activity","arguments":{"sinceHours":24}}}'
```

Expected:

- HTTP `200`.
- Response content is JSON with `teammates` and `since`.
- Results are scoped to repos visible to the authenticated user.

Negative checks:

```sh
curl -i http://localhost:10000/mcp \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

curl -i http://localhost:10000/mcp \
  -H 'Authorization: Bearer bad-key' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Expected: both return HTTP `401`.

## Verify `/v1/managed-agent-sessions`

Upsert a team-visible row:

```sh
curl -i http://localhost:10000/v1/managed-agent-sessions \
  -X PUT \
  -H 'Authorization: Bearer <device-api-key>' \
  -H 'Content-Type: application/json' \
  --data '{
    "agentId":"manual-agent",
    "sessionId":"manual-session",
    "mode":"cloud",
    "visibility":"team",
    "name":"Manual test",
    "startedAt":"2026-04-25T12:00:00.000Z"
  }'
```

Expected:

- HTTP `200`.
- Server log includes `agent_session_upsert`.

List rows:

```sh
curl -i http://localhost:10000/v1/managed-agent-sessions \
  -H 'Authorization: Bearer <device-api-key>'
```

Expected: `manual-session` appears.

Private-row check:

```sh
curl -i http://localhost:10000/v1/managed-agent-sessions \
  -X PUT \
  -H 'Authorization: Bearer <device-api-key>' \
  -H 'Content-Type: application/json' \
  --data '{
    "agentId":"manual-private",
    "sessionId":"manual-private-session",
    "mode":"local",
    "visibility":"private",
    "startedAt":"2026-04-25T12:05:00.000Z"
  }'

curl -s http://localhost:10000/v1/managed-agent-sessions \
  -H 'Authorization: Bearer <device-api-key>' | jq .
```

Expected: `manual-private-session` is not returned.

## Claude Code Smoke Test

Restart Claude Code after updating `~/.claude.json`, then verify the Slashtalk MCP server connects. Success is a connected server with `get_team_activity` and `get_session` listed, and no `share_workspace` tool listed.

Watch `apps/server` logs while Claude Code starts. Expected log:

```json
{ "level": "info", "msg": "mcp_session_opened", "...": "..." }
```

## Cleanup

Restore any previous `~/.claude.json` entry for `slashtalk-mcp`, remove `apps/desktop/.env` if it was only for this test, and stop local containers when done:

```sh
docker rm -f slashtalk-dev-pg slashtalk-dev-redis
```

## Verification Log

- 2026-04-25: Claude Code connected to `http://localhost:10000/mcp` and server logged `mcp_session_opened` with `clientInfo.name="claude-code"`. Claude showed no advertised tools, which was expected for Phase 1 after removing `share_workspace`.
- 2026-04-25: Assistant ran `/v1/managed-agent-sessions` smoke test using the Claude Code device API key from local config without printing the token. Team-visible upsert returned `200`, list returned the inserted `sessionId`, private upsert returned `200`, and private list returned `0` sessions.
