# MCP OAuth Discovery Spike Manual Test

This spike is intentionally throwaway. It observes how Claude Code and Codex behave before we add permanent OAuth tables, routes, token validation, or registration policy to `apps/server`.

The spike server implements:

- `/mcp` returning `401` with RFC 9728 `WWW-Authenticate: Bearer resource_metadata="..."` when no spike token is present.
- `/.well-known/oauth-protected-resource`.
- `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`.
- `/oauth/register` for Dynamic Client Registration observation.
- `/oauth/authorize` that redirects back with a dummy code.
- `/oauth/token` that returns a dummy access token.
- Minimal MCP `initialize` and `tools/list` responses after the dummy bearer is used.

References:

- RFC 9728 Protected Resource Metadata: https://www.rfc-editor.org/rfc/rfc9728.html
- Claude Code MCP auth docs: https://code.claude.com/docs/en/mcp
- Codex MCP config docs: https://developers.openai.com/codex/config-reference

## Start The Spike

```sh
bun --filter @slashtalk/server spike:mcp-oauth
```

Expected startup log:

```json
{"msg":"mcp_oauth_spike_listening","url":"http://127.0.0.1:37620","resource":"http://127.0.0.1:37620/mcp"}
```

Override the port if needed:

```sh
MCP_OAUTH_SPIKE_PORT=37621 bun --filter @slashtalk/server spike:mcp-oauth
```

## Endpoint Smoke

Verify unauthenticated discovery challenge:

```sh
curl -i http://127.0.0.1:37620/mcp \
  -X POST \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

Expected:

- HTTP `401`.
- `www-authenticate: Bearer resource_metadata="http://127.0.0.1:37620/.well-known/oauth-protected-resource"`.

Verify metadata:

```sh
curl -s http://127.0.0.1:37620/.well-known/oauth-protected-resource
curl -s http://127.0.0.1:37620/.well-known/oauth-authorization-server
```

Expected protected-resource metadata includes:

```json
{
  "resource": "http://127.0.0.1:37620/mcp",
  "authorization_servers": ["http://127.0.0.1:37620"],
  "scopes_supported": ["mcp:read", "mcp:write"],
  "bearer_methods_supported": ["header"]
}
```

Expected authorization-server metadata includes:

```json
{
  "issuer": "http://127.0.0.1:37620",
  "authorization_endpoint": "http://127.0.0.1:37620/oauth/authorize",
  "token_endpoint": "http://127.0.0.1:37620/oauth/token",
  "registration_endpoint": "http://127.0.0.1:37620/oauth/register",
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "protected_resources": ["http://127.0.0.1:37620/mcp"]
}
```

Verify the dummy issued token can initialize MCP:

```sh
curl -i http://127.0.0.1:37620/mcp \
  -X POST \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer slashtalk-oauth-spike-access' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

Expected: HTTP `200`, an `mcp-session-id` header, and `serverInfo.name` of `slashtalk-oauth-spike`.

## Claude Code Observation

Use a distinct test server name so we do not overwrite the real Slashtalk entry:

```sh
claude mcp remove slashtalk-oauth-spike || true
claude mcp add --transport http slashtalk-oauth-spike http://127.0.0.1:37620/mcp
claude mcp get slashtalk-oauth-spike
```

Then open Claude Code and use `/mcp` to inspect or authenticate `slashtalk-oauth-spike`.

Watch the spike server logs and record:

- Does Claude first request `/mcp` and receive the `WWW-Authenticate` challenge?
- Does it fetch `/.well-known/oauth-protected-resource`?
- Does it fetch `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`?
- Does it call `/oauth/register` for Dynamic Client Registration?
- What exact `redirect_uris`, `scope`, `grant_types`, and `token_endpoint_auth_method` does it send?
- Does `/oauth/authorize` include `resource`, `code_challenge`, `code_challenge_method`, `scope`, and `state`?
- Does `/oauth/token` include `resource`, `code_verifier`, and `client_id`?
- After token exchange, does Claude retry `/mcp` with `Authorization: Bearer ...`?
- Does Claude accept plain `http://127.0.0.1` metadata for local testing, or does it require HTTPS for any part of OAuth?

Clean up:

```sh
claude mcp remove slashtalk-oauth-spike
```

## Claude Static Client Variant

This checks whether Claude skips DCR when a public client id is supplied:

```sh
claude mcp remove slashtalk-oauth-spike || true
claude mcp add \
  --transport http \
  --callback-port 37622 \
  --client-id slashtalk-static-claude-code \
  slashtalk-oauth-spike \
  http://127.0.0.1:37620/mcp
```

Then authenticate via `/mcp` in Claude Code and record whether `/oauth/register` is skipped and whether the authorization request uses `client_id=slashtalk-static-claude-code`.

Clean up:

```sh
claude mcp remove slashtalk-oauth-spike
```

## Codex Observation

Use a distinct Codex entry:

```sh
codex mcp remove slashtalk-oauth-spike || true
codex mcp add slashtalk-oauth-spike --url http://127.0.0.1:37620/mcp
codex mcp get slashtalk-oauth-spike
codex mcp login slashtalk-oauth-spike
```

Watch the spike server logs and record:

- Does `codex mcp login` request `/mcp` first, or does it go straight to metadata discovery?
- Does it fetch RFC 9728 protected-resource metadata?
- Does it fetch RFC 8414 authorization-server metadata?
- Does it use `/oauth/register` for Dynamic Client Registration?
- What exact `redirect_uris`, `scope`, `grant_types`, and `token_endpoint_auth_method` does it send?
- Does `/oauth/authorize` include `resource`, `code_challenge`, `code_challenge_method`, `scope`, and `state`?
- Does `/oauth/token` include `resource`, `code_verifier`, and `client_id`?
- Does Codex require explicit `--scopes`, and if so, which scope format works?
- Does Codex accept plain `http://127.0.0.1` metadata for local testing?

Optional scope-pinned run:

```sh
codex mcp logout slashtalk-oauth-spike || true
codex mcp login slashtalk-oauth-spike --scopes mcp:read,mcp:write
```

Clean up:

```sh
codex mcp logout slashtalk-oauth-spike || true
codex mcp remove slashtalk-oauth-spike
```

## What To Capture

Copy the structured JSON logs from the spike server for each client run. The most important events are:

- First unauthenticated `/mcp` request.
- Metadata endpoint sequence.
- DCR request body, if any.
- Authorization request query.
- Token request body.
- Authenticated `/mcp` retry.

Do not paste real OAuth tokens from other services. The spike token values are dummy and safe to include.

## Assistant Smoke Result

On 2026-04-25, assistant-run curl smoke verified:

- `/mcp` returns `401` with RFC 9728 `resource_metadata`.
- Protected-resource metadata returns `resource`, `authorization_servers`, scopes, and bearer method.
- Authorization-server metadata returns authorize/token/register endpoints, PKCE method, public-client token auth, scopes, and protected resources.
- `/mcp` accepts `Authorization: Bearer slashtalk-oauth-spike-access` and returns a minimal MCP initialize result.
