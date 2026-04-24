# Security

Threat model, secret handling, and credential storage for slashtalk.

## OAuth scope

`GET /auth/github` requests **`read:user read:org` only** — no `repo` scope. Consequences:

- We **cannot** call GitHub's `/user/repos` or read repo contents server-side.
- Repos are **claimed** on demand: the desktop app reads a local clone's `.git/config`, extracts `owner/name`, and POSTs `/api/me/repos { fullName }`. The user proves possession by being able to clone it — GitHub already gated access at clone time.
- `repos.github_id` is therefore nullable (we don't always know the numeric ID); code must not treat its absence as a bug.
- Historical `syncUserRepos` / `POST /api/me/sync-repos` have been removed.

## Token storage and hashing

| Artifact | At rest | Returned to caller |
| --- | --- | --- |
| GitHub OAuth access token | AES-256-GCM ciphertext in `users.github_token`, keyed by `ENCRYPTION_KEY` (format: `hex(iv):hex(ciphertext):hex(authTag)`, see `apps/server/src/auth/tokens.ts`) | Never. Used server-side for PR polling only. |
| Refresh token | SHA-256 hash in `refresh_tokens.token_hash` | Plaintext exactly once, at issuance, as an httpOnly cookie. |
| API key | SHA-256 hash in `api_keys.key_hash` | Plaintext exactly once, at `/v1/auth/exchange` response. |
| Setup token | SHA-256 hash in `setup_tokens.token`… (stored hashed) | Plaintext exactly once, to the desktop app during the loopback-port callback. |

**Rule.** Raw tokens, hashes, and encryption keys are never logged, returned in error responses, or serialized into Redis messages.

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
