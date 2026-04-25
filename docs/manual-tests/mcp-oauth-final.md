# MCP OAuth Final Interop Manual Test

This verifies direct MCP OAuth against `apps/server` without the desktop local proxy. The expected result is that Claude Code completes OAuth login, receives a Slashtalk MCP access token, and can initialize `/mcp` directly.

## Start Slashtalk

From the repo root:

```sh
bun run dev:server
```

Use `http://localhost:10000` unless the server logs a different port.

## Clean Previous Claude Entry

```sh
claude mcp remove slashtalk-oauth-local || true
```

## Add Direct OAuth MCP Server

```sh
claude mcp add \
  --transport http \
  slashtalk-oauth-local \
  http://localhost:10000/mcp
```

For the static-client path, use:

```sh
claude mcp add \
  --transport http \
  --client-id slashtalk-static-claude-code \
  slashtalk-oauth-local \
  http://localhost:10000/mcp
```

## Authenticate

Open Claude Code and run:

```text
/mcp
```

Select `slashtalk-oauth-local`, then authenticate. The browser should go through Slashtalk GitHub sign-in if needed and return to Claude's local callback URL.

## Expected Server Logs

During login:

- `POST /mcp` returns `401` with `WWW-Authenticate`.
- `GET /.well-known/oauth-protected-resource`.
- `GET /.well-known/oauth-authorization-server`.
- Optional `POST /oauth/register` for Dynamic Client Registration.
- `GET /oauth/authorize`.
- `POST /oauth/token`.

After login:

- `mcp_session_opened` with `clientInfo.name="claude-code"`.
- A follow-up `tools/list` succeeds.

The current migration intentionally advertises no MCP tools, so an empty tool list is a success.

## Negative Check

This should return `401` with `error="invalid_token"`:

```sh
curl -i http://localhost:10000/mcp \
  -H 'authorization: Bearer bad-token' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual","version":"0.0.0"}}}'
```

## Sign-Out-Everywhere Check

After a successful Claude or Codex OAuth login, open Slashtalk settings and use
`Sign out everywhere`. Then restart or reconnect the MCP client.

Expected result:

- The server logs `auth_audit` with `event="credentials_revoked"` and `scope="global"`.
- The next MCP request from the previously authenticated client is rejected with `error_description="revoked"` or the client asks you to authenticate again.
- Other users' MCP OAuth sessions are unaffected.

## Cleanup

```sh
claude mcp remove slashtalk-oauth-local
```

## Verification Log

- 2026-04-25: Claude Code 2.1.119 completed direct OAuth authentication against `http://localhost:10000/mcp`. Server logged `mcp_session_opened` for `giuseppecrj` with `clientInfo.name="claude-code"` and later `mcp_session_closed` with `reason="stream_abort"`. Empty tool list remains expected for this migration phase.
- 2026-04-25: Codex 0.125.0 completed direct OAuth authentication against `http://localhost:10000/mcp` and started without MCP startup failures after the server advertised empty `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list` responses. Server logged `mcp_session_opened` for `giuseppecrj` with `clientInfo.name="codex-mcp-client"`.
