# Security

Threat model, secret handling, and credential storage for slashtalk.

## OAuth scope

`GET /auth/github` requests **`read:user read:org` only** — no `repo` scope, no GitHub App. Private repo _contents_ are never read by the server; access is gated entirely on the caller's GitHub org membership.

- We cannot read repo contents server-side. The OAuth token covers identity, org listing, and public-repo metadata.
- Repos are **claimed** on demand: the desktop reads a local clone's `.git/config`, extracts `owner/name`, and POSTs `/api/me/repos { fullName }`. The server gates the claim on org membership or personal-namespace match — see § Repo-claim verification.
- `repos.github_id` is nullable; pre-gate rows may have it set, post-gate rows generally don't (no GitHub `/repos/:owner/:name` call is made under the new gate).
- Historical `syncUserRepos` / `POST /api/me/sync-repos` have been removed.

## Repo-claim verification

`POST /api/me/repos` is the single gate between a desktop-initiated repo claim and any cross-user data access. Downstream routes (`/api/feed*`, `/api/session/:id`, `/api/session/:id/events`, WS `repo:<id>` subscriptions) all authorize reads via a `user_repos` row, so an unverified claim would let any JWT holder read another user's sessions. The server therefore confirms a stable property of the caller before creating the row.

The gate accepts a claim iff:

1. The repo's owner is in the caller's **active GitHub org memberships**, fetched from `GET https://api.github.com/user/memberships/orgs?state=active` with the user's stored OAuth token. Match is case-insensitive on org login. **OR**
2. `owner === user.githubLogin` (personal namespace). This branch short-circuits before any GitHub call — the caller's own login is trusted from the JWT, which was minted from a verified `/auth/github/callback`.

Anything else is rejected with **403 `no_access`** and the message: _"GitHub doesn't show this repo in your orgs. If your org restricts OAuth apps, an admin may need to approve slashtalk."_ Org-level OAuth-app restrictions are a real failure mode here — an org with third-party-OAuth restrictions silently disappears from `/user/memberships/orgs` until an org owner approves the slashtalk OAuth app at `https://github.com/organizations/<org>/settings/oauth_application_policy`.

Other failure modes:

- `401` from `/user/memberships/orgs` → token revoked. Run the global credentials cascade (`revokeAllUserCredentials`) and respond **401 `token_expired`**. Desktop surfaces a re-sign-in prompt and calls `backend.signOut()`.
- `403` (rate limit / abuse) or 5xx or network failure → **502 `upstream_unavailable`**. Desktop shows a retry hint. We do not invalidate the session for transient upstream failures.
- A per-user **30-claims-per-hour rate limit** is a generic abuse guard.
- A 60-second per-user org-memberships cache dedups retries and keeps GitHub-call volume low under repeated claim attempts.

The claim endpoint responds with structured `{ error, message }` JSON on every non-2xx outcome.

The `/v1/devices/:id/repos` endpoint relies transitively on this gate: it only accepts `repoId`s the caller already tracks in `user_repos`, so there is no path that inserts a device-level registration for a repo the user hasn't claimed.

**Trust-model note.** Org membership — not GitHub's per-repo ACL — is the cross-user trust boundary. Any active member of `acme` can claim any `acme/*` repo and inherit cross-user visibility on other slashtalk users' sessions for that repo, even repos GitHub itself wouldn't grant them read access to. This matches the trust posture of Slack, Linear, Notion, etc. **If your team uses GitHub repo-level permissions to enforce information barriers (M&A, legal, compliance, security incident response), do not adopt slashtalk for those repos.** We have no in-product mitigation for intra-org leakage today; it is not enforced at the GitHub API layer.

A one-shot maintenance script — [`scripts/reclassify-by-org.ts`](../apps/server/scripts/reclassify-by-org.ts) — re-evaluates every existing `user_repos` row against the new gate and deletes rows that no longer pass (typically: claims of public repos owned by orgs the user isn't a member of, made under the previous per-repo verification model). Run once after deploying the new gate.

**Re-verification on org-membership changes is deferred.** A user removed from an org keeps their stale `user_repos` rows until manually cleaned up. A future change should re-run the gate on each session refresh and revoke rows whose org membership has lapsed.

See also core-beliefs [#11](design-docs/core-beliefs.md#11-identity-is-user-oauth-no-github-app), [#12](design-docs/core-beliefs.md#12-repo-access-is-verified-not-asserted), [#13](design-docs/core-beliefs.md#13-user_repos-is-the-only-authorization-for-cross-user-reads).

## Token storage and hashing

| Artifact                  | At rest                                                                                                                                                                                                | Returned to caller                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| GitHub OAuth access token | AES-256-GCM ciphertext in `users.github_token`, keyed by `ENCRYPTION_KEY` (format: `hex(iv):hex(ciphertext)` — WebCrypto appends the auth tag to the ciphertext; see `apps/server/src/auth/tokens.ts`) | Never. Used server-side for org-membership checks and the GitHub orgs proxy.  |
| Refresh token             | SHA-256 hash in `refresh_tokens.token_hash`                                                                                                                                                            | Plaintext exactly once, at issuance, as an httpOnly cookie.                   |
| API key                   | SHA-256 hash in `api_keys.key_hash`                                                                                                                                                                    | Plaintext exactly once, at `/v1/auth/exchange` response.                      |
| Setup token               | SHA-256 hash in `setup_tokens.token`… (stored hashed)                                                                                                                                                  | Plaintext exactly once, to the desktop app during the loopback-port callback. |
| MCP OAuth token           | SHA-256 hashes in `oauth_tokens.access_token_hash` and `oauth_tokens.refresh_token_hash`                                                                                                               | Plaintext exactly once, at `/oauth/token` issuance or refresh rotation.       |

**Rule.** Raw tokens, hashes, and encryption keys are never logged, returned in error responses, or serialized into Redis messages.

## MCP auth model

`apps/server` owns the MCP HTTP resource at root `/mcp`. This is the deliberate exception to the route-prefix auth rule: MCP versioning is negotiated in the protocol initialize handshake, so the resource URL remains `/mcp` instead of `/v1/mcp`.

Current consolidation behavior:

- Desktop signs in through GitHub OAuth against `apps/server`.
- `apps/server` issues a JWT/refresh pair, then the desktop exchanges a setup token for a device API key through `/v1/auth/exchange`.
- `/mcp` accepts `Authorization: Bearer <device-api-key>` for desktop-local proxy and legacy compatibility.
- Local Claude Code and Codex installs should point at the desktop-local proxy (`http://127.0.0.1:<persisted-port>/mcp`). The desktop binds an ephemeral local port on first launch, persists the non-secret port in userData, writes a random local-only `X-Slashtalk-Proxy-Token` header into client config, and stores the matching secret with Electron `safeStorage`. The proxy requires that header, strips it before forwarding, then injects the safeStorage-backed device API key per request. Client config must never contain the Slashtalk device API key. The fallback proxy secret path uses the same strength as the persisted production path: 32 random bytes, base64url-encoded. Claude Code and Codex do not currently expose a supported per-server config field for custom offline recovery copy; offline proxy recovery lives in the manual test runbook.
- `/v1/managed-agent-sessions` is also served by `apps/server` with `apiKeyAuth`; reads are self-only until rows gain repo linkage, and private managed-agent sessions are not returned by the list endpoint.
- The old public `/mcp/presence` debug route has been removed. MCP presence state is internal process state, not a public snapshot API.

Direct MCP OAuth behavior:

- `/mcp` returns `401` with `WWW-Authenticate: Bearer resource_metadata="..."` so OAuth-capable MCP clients can discover protected-resource metadata.
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` describe root `/mcp`; authorization-server metadata is served at the standard root paths plus Claude/Codex-compatible `/mcp` variants.
- `/oauth/register` supports Dynamic Client Registration for public loopback clients. `slashtalk-static-claude-code` is also accepted as a static public client.
- `/oauth/authorize` requires a signed-in Slashtalk browser session, routing through GitHub sign-in when needed, then issues a short-lived one-time authorization code bound to client, redirect URI, scope, PKCE challenge, user, and `/mcp` resource.
- `/oauth/token` exchanges authorization codes with PKCE and returns opaque MCP access/refresh tokens. Token hashes are stored in `oauth_tokens`; access tokens are short lived and bound to `/mcp`. Authorization codes and refresh tokens are consumed with conditional transaction updates so concurrent replay yields exactly one success.
- `/mcp` accepts valid MCP OAuth access tokens with `mcp:read` scope, and rejects expired, revoked, wrong-resource, unknown, or insufficient-scope tokens with `WWW-Authenticate` `invalid_token` details.
- `/oauth/register` and `/oauth/token` have in-process write-rate limits and emit `auth_audit` `mcp_oauth_rate_limited` on rejection. Edge/global traffic shaping is still a deployment concern.

Static bearer config remains an explicit compatibility bridge and should be treated as a long-lived device credential: revoke the device API key if it is exposed.

Revocation scopes:

- Normal sign-out (`POST /auth/logout`) revokes only the presented refresh token and clears local cookies/desktop credentials.
- Device revoke (`DELETE /api/me/devices/:id`) deletes that device and its API key; other devices, refresh tokens, and MCP OAuth grants remain valid.
- Sign out everywhere (`POST /auth/logout-everywhere`) deletes all refresh tokens and device API keys for the signed-in user, revokes all of that user's MCP OAuth access/refresh tokens, and forces existing MCP clients to re-authenticate on their next request.
- GitHub OAuth grant revocation detected through a GitHub `401` on user-backed repo/org API calls runs the same global cascade.
- The global cascade also bumps `users.credentials_revoked_at`; `jwtAuth` rejects already-issued JWT session cookies whose issue time is older than that timestamp. A fresh sign-in after the cascade receives a new valid JWT.

## JWT session cookie

- Algorithm: HS256, signed with `JWT_SECRET`.
- Name: `session` (httpOnly, secure in production, sameSite=lax).
- Lifetime: short (1 h). Refresh via `POST /auth/refresh` (rotates the refresh token).
- The desktop app also sends the JWT as a raw `Cookie: session=<jwt>` header to `/api/me/*`; single-flight refresh in `apps/desktop/src/main/backend.ts` coordinates concurrent 401 retries.
- `jwtAuth` compares each JWT issue time against `users.credentials_revoked_at`, so sign-out-everywhere and detected GitHub grant revocation invalidate existing browser/desktop session authority immediately.

## Desktop credential storage

Both the JWT and the API key are persisted in Electron `safeStorage`:

- macOS → Keychain
- Windows → DPAPI
- Linux → libsecret (via kwallet or gnome-keyring)

See `apps/desktop/src/main/safeStore.ts`. If `safeStorage.isEncryptionAvailable()` is false, credentials are **not** persisted and the user is re-prompted on next launch.

The desktop-local MCP proxy secret is also stored with `safeStorage`. It is not a Slashtalk server credential; it is an admission token proving the caller received desktop-installed local config before the proxy injects the real device API key.

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
