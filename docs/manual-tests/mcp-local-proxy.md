# MCP Local Proxy Manual Test

Phase 2 verifies that Claude Code and Codex can talk to Slashtalk MCP through the desktop-local proxy without writing the Slashtalk device API key into their config files.

## Setup

Use the consolidated server from Phase 1. The former standalone `apps/mcp` service has been removed, so all local proxy testing should point at the server-owned `/mcp` route.

```sh
cat > apps/desktop/.env <<'EOF'
MAIN_VITE_SLASHTALK_API_URL=http://localhost:10000
EOF

bun run dev
```

Expected desktop log:

```text
[localMcpProxy] listening { url: "http://127.0.0.1:<port>/mcp" }
```

Use the logged URL as `<local-proxy-url>` in the commands below. The desktop binds an ephemeral port on first launch, persists it in userData, and reuses it on later launches. To pin a port for local testing, set the override before starting the desktop:

```sh
export SLASHTALK_LOCAL_MCP_PORT=37614
```

Then sign in through the desktop app.

## Verify Claude Code Config

The desktop auto-installs the Claude Code entry after sign-in. Confirm `~/.claude.json` contains Slashtalk with the local proxy admission header and no Slashtalk bearer:

```json
{
  "mcpServers": {
    "slashtalk-mcp": {
      "type": "http",
      "url": "<local-proxy-url>",
      "headers": {
        "X-Slashtalk-Proxy-Token": "<local-proxy-secret>"
      }
    }
  }
}
```

There should be no `headers.Authorization` on the `slashtalk-mcp` entry. `X-Slashtalk-Proxy-Token` is a local-only proxy admission secret, not the server device API key.

## Verify Codex Config

Install the Codex entry from the running desktop app so it uses the same safeStorage-backed local proxy secret as the proxy process. Do not install Codex by importing `installMcp.ts` directly from a separate Bun process; that process cannot read Electron safeStorage and will generate a different fallback secret.

Confirm `~/.codex/config.toml` contains:

```toml
[mcp_servers.slashtalk-mcp]
url = "<local-proxy-url>"
enabled = true
http_headers = { "X-Slashtalk-Proxy-Token" = "<local-proxy-secret>" }
```

There should be no `Authorization`, `env_http_headers`, `bearer_token_env_var`, or device API key in the Slashtalk Codex section. The only expected secret is the local proxy admission value in `http_headers`.

## Proxy Smoke Test

With the desktop signed in and running, initialize MCP through the local proxy:

```sh
curl -i <local-proxy-url> \
  -X POST \
  -H 'X-Slashtalk-Proxy-Token: <local-proxy-secret>' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-local-proxy","version":"0.0.1"}}}'
```

Expected:

- Local proxy returns `200`.
- Response includes `mcp-session-id`.
- Server log includes `mcp_session_opened` for your user.
- The MCP tool list includes `get_team_activity` and `get_session`.

Use the returned session id to list tools:

```sh
curl -i <local-proxy-url> \
  -X POST \
  -H 'X-Slashtalk-Proxy-Token: <local-proxy-secret>' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -H 'mcp-session-id: <mcp-session-id>' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Expected body includes `get_team_activity` and `get_session`, and does not include `share_workspace`.

Call the team activity tool through the proxy:

```sh
curl -i <local-proxy-url> \
  -X POST \
  -H 'X-Slashtalk-Proxy-Token: <local-proxy-secret>' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -H 'mcp-session-id: <mcp-session-id>' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_team_activity","arguments":{"sinceHours":24}}}'
```

Expected response content is JSON with `teammates` and `since`, scoped to repos visible to the signed-in desktop user.

## Real Client Checks

Claude Code:

1. Restart Claude Code after the config update.
2. Open `/mcp`.
3. Select `slashtalk-mcp`.
4. Confirm it shows connected at `<local-proxy-url>`.
5. Confirm auth is not an OAuth browser flow in this phase; the desktop proxy is providing the server bearer.

Codex:

1. Restart Codex after the config update.
2. Open `/mcp` in the TUI.
3. Confirm `slashtalk-mcp` is enabled and points at `<local-proxy-url>`.
4. Confirm server logs include `mcp_session_opened` with Codex client info when Codex connects.

## Desktop Restart Preserves Connection

1. Install the Claude Code MCP entry from the running desktop app.
2. Open Claude Code, run `/mcp`, and confirm `slashtalk-mcp` is connected at `<local-proxy-url>`.
3. Quit Slashtalk Desktop.
4. Relaunch Slashtalk Desktop without changing `SLASHTALK_LOCAL_MCP_PORT`.
5. Confirm the desktop log shows the same `<local-proxy-url>`.
6. In the same Claude Code session, confirm `slashtalk-mcp` reconnects without re-running install.

Expected: the bound port is reused and the existing Claude Code session recovers after the desktop proxy is back.

## Saved-Port Collision Recovery

1. Record the saved `<local-proxy-url>` from the desktop log.
2. Quit Slashtalk Desktop.
3. Occupy the saved port from another terminal:

   ```sh
   nc -l <saved-port>
   ```

4. Relaunch Slashtalk Desktop.
5. Confirm the desktop starts, logs a different `<local-proxy-url>`, and rewrites installed local-proxy client configs to that URL with a new local proxy secret.
6. Confirm `curl <new-local-proxy-url>` with the new local proxy secret reaches the proxy, while the previous secret returns `401`.

Expected: saved-port `EADDRINUSE` falls back to port-zero, rotates the local proxy admission secret, persists the new port, and reconciles installed local-proxy config. Existing Claude Code legacy-bearer installs should not be converted.

## Recovery: ECONNREFUSED on slashtalk-mcp

Claude Code and Codex do not currently expose a supported per-server config field for custom offline recovery copy. If either client reports a raw transport error such as `ECONNREFUSED` for `slashtalk-mcp`, verify the desktop-local proxy is running:

1. Start or relaunch Slashtalk Desktop.
2. Confirm the desktop log includes `[localMcpProxy] listening`.
3. Confirm `~/.claude.json` or `~/.codex/config.toml` points `slashtalk-mcp` at the logged `<local-proxy-url>`.
4. Retry `/mcp` in Claude Code or Codex.

Manual evidence to record during verification:

- Claude Code offline error text: `<record observed text>`
- Codex offline error text: `<record observed text>`

## Negative Checks

Sign out of the desktop, keep it running, then call the local proxy:

```sh
curl -i <local-proxy-url> \
  -X POST \
  -H 'X-Slashtalk-Proxy-Token: <local-proxy-secret>' \
  --data '{}'
```

Expected:

- Local proxy returns `401`.
- Response text mentions the desktop is not signed in.
- Server does not log a new MCP session.

Then sign back in and call the proxy without the local proxy admission secret:

```sh
curl -i <local-proxy-url> -X POST --data '{}'
```

Expected:

- Local proxy returns `401`.
- Server does not log a new MCP session.

Then call the proxy with a deliberately wrong incoming bearer but the correct proxy admission secret:

```sh
curl -i <local-proxy-url> \
  -X POST \
  -H 'X-Slashtalk-Proxy-Token: <local-proxy-secret>' \
  -H 'authorization: Bearer wrong-token' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-local-proxy-negative","version":"0.0.1"}}}'
```

Expected:

- Request succeeds if the desktop is signed in.
- Server logs show your signed-in Slashtalk user, proving the proxy ignored the inbound bearer and injected the safeStorage-backed device API key.

## Cleanup

Uninstall the generated entries if needed:

```sh
cd apps/desktop
bun -e 'import("./src/main/installMcp.ts").then((m) => Promise.all([m.uninstall("claude-code"), m.uninstall("codex")]))'
```

Restore any previous `slashtalk-mcp` client config and stop local dev processes.
