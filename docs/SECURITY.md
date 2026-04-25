# Security

Threat model, secret handling, and credential storage for slashtalk.

## OAuth scope

`GET /auth/github` requests **`read:user read:org` only** — no `repo` scope. Consequences:

- We **cannot** read repo contents server-side. We **can** call `GET /repos/:owner/:name` and `GET /user/orgs` to confirm visibility; both are how the claim-gate and org picker verify access.
- Repos are **claimed** on demand: the desktop app reads a local clone's `.git/config`, extracts `owner/name`, and POSTs `/api/me/repos { fullName }`. The server verifies possession at claim time by calling `GET /repos/:owner/:name` with the user's stored OAuth token — see § Repo-claim verification.
- `repos.github_id` is populated from that verification response. Legacy rows predating the claim-gate may be null; a backfill via [`scripts/reverify-claims.ts`](../apps/server/scripts/reverify-claims.ts) closes that gap.
- Historical `syncUserRepos` / `POST /api/me/sync-repos` have been removed.

## Repo-claim verification

`POST /api/me/repos` is the single gate between a desktop-initiated repo claim and any cross-user data access. Downstream routes (`/api/feed*`, `/api/session/:id`, `/api/session/:id/events`, WS `repo:<id>` subscriptions) all authorize reads via a `user_repos` row, so an unverified claim would let any JWT holder read another user's sessions. The server therefore confirms the caller can see the repo on GitHub before creating the `user_repos` row.

- The handler decrypts `users.github_token` via `fetchUserGithubToken` and calls `GET https://api.github.com/repos/:owner/:name`.
- `200` → accept. Persist `repos.github_id`, canonical `repos.owner`/`repos.name`, and `repos.private` from the response body.
- `404` → reject with **403 `no_access`**. The caller does not have visibility on GitHub; we must not grant visibility here.
- `401` / `403` from GitHub → reject with **401 `token_expired`**. The desktop surfaces a re-sign-in prompt and calls `backend.signOut()`.
- Fetch errors or 5xx from GitHub → reject with **502 `upstream_unavailable`**. The desktop shows a retry hint.
- A per-user **30-claims-per-hour rate limit** guards against brute-force repo-name enumeration with a stolen JWT.
- A 60-second (userId, fullName) cache dedups retries (desktop double-clicks) without re-hitting GitHub.

The claim endpoint responds with structured `{ error, message }` JSON on every non-2xx outcome so the desktop can branch on `error` and display `message` verbatim.

The `/v1/devices/:id/repos` endpoint relies transitively on this gate: it only accepts `repoId`s the caller already tracks in `user_repos`, so there is no path that inserts a device-level registration for a repo the user hasn't verified-claimed.

A one-shot maintenance script — [`scripts/reverify-claims.ts`](../apps/server/scripts/reverify-claims.ts) — re-verifies every pre-existing `user_repos` row against GitHub and deletes rows where the stored token no longer has access. Run once before deploying the gated claim endpoint, and again any time we suspect pre-gate leaks may have been persisted.

See also core-beliefs [#11](design-docs/core-beliefs.md#11-identity-is-user-oauth-no-github-app), [#12](design-docs/core-beliefs.md#12-repo-access-is-verified-not-asserted), [#13](design-docs/core-beliefs.md#13-user_repos-is-the-only-authorization-for-cross-user-reads).

## Token storage and hashing

| Artifact | At rest | Returned to caller |
| --- | --- | --- |
| GitHub OAuth access token | AES-256-GCM ciphertext in `users.github_token`, keyed by `ENCRYPTION_KEY` (format: `hex(iv):hex(ciphertext)` — WebCrypto appends the auth tag to the ciphertext; see `apps/server/src/auth/tokens.ts`) | Never. Used server-side for PR polling only. |
| Refresh token | SHA-256 hash in `refresh_tokens.token_hash` | Plaintext exactly once, at issuance, as an httpOnly cookie. |
| API key | SHA-256 hash in `api_keys.key_hash` | Plaintext exactly once, at `/v1/auth/exchange` response. |
| Setup token | SHA-256 hash in `setup_tokens.token`… (stored hashed) | Plaintext exactly once, to the desktop app during the loopback-port callback. |

**Rule.** Raw tokens, hashes, and encryption keys are never logged, returned in error responses, or serialized into Redis messages.

## MCP auth model

`apps/server` owns the MCP HTTP resource at root `/mcp`. This is the deliberate exception to the route-prefix auth rule: MCP versioning is negotiated in the protocol initialize handshake, so the resource URL remains `/mcp` instead of `/v1/mcp`.

Current consolidation behavior:

- Desktop signs in through GitHub OAuth against `apps/server`.
- `apps/server` issues a JWT/refresh pair, then the desktop exchanges a setup token for a device API key through `/v1/auth/exchange`.
- `/mcp` accepts `Authorization: Bearer <device-api-key>` for desktop-local proxy and legacy compatibility.
- Local Claude Code and Codex installs should point at the desktop-local proxy (`http://127.0.0.1:37613/mcp` by default). The proxy injects the safeStorage-backed device API key per request, so client config does not store a static Slashtalk bearer.
- `/v1/managed-agent-sessions` is also served by `apps/server` with `apiKeyAuth`; private managed-agent sessions are not returned by the list endpoint.

Direct MCP OAuth behavior:

- `/mcp` returns `401` with `WWW-Authenticate: Bearer resource_metadata="..."` so OAuth-capable MCP clients can discover protected-resource metadata.
- `/.well-known/oauth-protected-resource` describes root `/mcp`; authorization-server metadata is served at the standard root paths plus Claude/Codex-compatible `/mcp` variants.
- `/oauth/register` supports Dynamic Client Registration for public loopback clients. `slashtalk-static-claude-code` is also accepted as a static public client.
- `/oauth/authorize` requires a signed-in Slashtalk browser session, routing through GitHub sign-in when needed, then issues a short-lived one-time authorization code bound to client, redirect URI, scope, PKCE challenge, user, and `/mcp` resource.
- `/oauth/token` exchanges authorization codes with PKCE and returns opaque MCP access/refresh tokens. Token hashes are stored in `oauth_tokens`; access tokens are short lived and bound to `/mcp`. Refresh tokens rotate on use and replay is rejected.
- `/mcp` accepts valid MCP OAuth access tokens with `mcp:read` scope, and rejects expired, revoked, wrong-resource, unknown, or insufficient-scope tokens with `WWW-Authenticate` `invalid_token` details.

Static bearer config remains an explicit compatibility bridge and should be treated as a long-lived device credential: revoke the device API key if it is exposed.

Revocation scopes:

- Normal sign-out (`POST /auth/logout`) revokes only the presented refresh token and clears local cookies/desktop credentials.
- Device revoke (`DELETE /api/me/devices/:id`) deletes that device and its API key; other devices, refresh tokens, and MCP OAuth grants remain valid.
- Sign out everywhere (`POST /auth/logout-everywhere`) deletes all refresh tokens and device API keys for the signed-in user, revokes all of that user's MCP OAuth access/refresh tokens, and forces existing MCP clients to re-authenticate on their next request.

## JWT session cookie

- Algorithm: HS256, signed with `JWT_SECRET`.
- Name: `session` (httpOnly, secure in production, sameSite=lax).
- Lifetime: short (1 h). Refresh via `POST /auth/refresh` (rotates the refresh token).
- The desktop app also sends the JWT as a raw `Cookie: session=<jwt>` header to `/api/me/*`; single-flight refresh in `apps/desktop/src/main/backend.ts` coordinates concurrent 401 retries.

## Desktop credential storage

Both the JWT and the API key are persisted in Electron `safeStorage`:

- macOS → Keychain
- Windows → DPAPI
- Linux → libsecret (via kwallet or gnome-keyring)

See `apps/desktop/src/main/safeStore.ts`. If `safeStorage.isEncryptionAvailable()` is false, credentials are **not** persisted and the user is re-prompted on next launch.

## PII surface

Data that flows to the server and is stored:

- `users`: GitHub ID, login, avatar URL, display name.
- `sessions`: `project` (slugified cwd), `cwd`, `branch`, `model`, `version`, `title`, `last_user_prompt`, aggregated token counts, top file paths.
- `events.payload`: raw JSONL lines. Includes prompts, tool inputs/outputs, file contents (for `Read`/`Edit`/`Write` tools), shell commands.

Data that does **not** leave the desktop:

- Git remote URLs (we only see the `fullName` the user claimed).
- File contents outside what the `events.payload` preserves.
- Any session that fails the [strict-tracking gate](design-docs/core-beliefs.md#6-strict-tracking-gate-in-the-desktop-uploader).

## Secrets in WS payloads

WebSocket channel messages carry **identifiers only** (`session_id`, `repo_id`, `user_id`, `github_login`, timestamps). Clients fetch full snapshots via `/api/feed` / `/api/session/:id` under `jwtAuth`. Channels are namespaced by `repo:<id>`; subscription is gated on `user_repos` membership at WS open time.

## Environment

Required at boot (or `apps/server/src/config.ts` throws):

- `DATABASE_URL`, `REDIS_URL`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `JWT_SECRET` (≥32 chars)
- `ENCRYPTION_KEY` (64-char hex; `openssl rand -hex 32`)
- `BASE_URL`

Optional: `PORT` (10000), `ANTHROPIC_API_KEY` (analyzer scheduler disabled if unset), `ANALYZER_TICK_MS`, `ANALYZER_MAX_SESSIONS_PER_TICK`, `ANALYZER_CONCURRENCY`.

## Reporting

If you find a vulnerability, open a private issue in GitHub or email the maintainer listed in the repo's README. Do not file a public issue.
