---
task: mcp-auth-review-hardening
status: completed
created: 2026-04-25
origin: ce-code-review on g/migrate-mcp-to-server
---

# Plan: MCP Auth Review Hardening

## Problem Frame

The MCP auth consolidation is functionally verified, but code review found several security, data-boundary, and reliability issues that should be fixed before opening a PR. The work is not a new product phase; it is a focused hardening pass over the implemented MCP/OAuth/local-proxy migration.

This plan covers the accepted P1 and P2 findings from the review. It intentionally excludes findings contradicted by the approved migration scope, such as restoring the unused `share_workspace` test tool.

## Requirements Trace

- **R1 — Global revoke must actually revoke active browser authority.** After sign-out-everywhere or GitHub grant revocation, any already-issued JWT must stop authorizing new setup tokens, device API keys, or API reads that depend on user authority.
- **R2 — Managed-agent sessions must not create unverified cross-user reads.** Until managed-agent sessions are linked to repos, reads must be self-only. Cross-user reads can be reintroduced later only through verified `user_repos` authorization.
- **R3 — Managed-agent session IDs must be user-scoped.** A caller-supplied `sessionId` collision across users must not update or corrupt another user's row.
- **R4 — OAuth one-time credentials must be consumed atomically.** Authorization codes and refresh tokens must be single-use under concurrent requests.
- **R5 — MCP presence debug state must not be public.** `/mcp/presence` must be removed or protected by the same auth boundary as `/mcp`.
- **R6 — Desktop local proxy must not be an open localhost relay.** Local clients installed by desktop must prove they received the desktop-installed local proxy secret before the proxy injects the real Slashtalk API key.
- **R7 — Local proxy streams must release upstream work on disconnect.** If Claude/Codex disconnects from the local proxy, the upstream MCP fetch/stream must be aborted.
- **R8 — Managed-agent mode values must match the shared contract.** The server must only accept `"cloud"` or `"local"` for managed-agent `mode`.
- **R9 — OAuth protected-resource metadata should support path-derived discovery.** Serve `/.well-known/oauth-protected-resource/mcp` in addition to the root metadata endpoint.
- **R10 — Public OAuth write endpoints need abuse controls.** Dynamic client registration and token exchange need app-level rate limits or an explicit documented gateway dependency. Prefer app-level limits for local/dev parity.

## Decisions

- **JWT revocation state:** Add a user-level timestamp such as `credentialsRevokedAt` and include JWT `iat` when issuing session tokens. `jwtAuth` rejects tokens issued before that timestamp. This is simpler than per-token deny lists and matches the existing global-revoke semantics.
- **Managed-agent reads:** Make `/v1/managed-agent-sessions` self-only for now. There is no repo foreign key on `agent_sessions`, so any cross-user team visibility is not yet enforceable through `user_repos`.
- **Managed-agent uniqueness:** Change uniqueness from global `session_id` to `(user_login, session_id)` and update the upsert conflict target accordingly.
- **OAuth atomicity:** Use conditional `UPDATE ... RETURNING` inside a transaction for both auth-code consumption and refresh-token rotation. Issue new tokens only if exactly one row was consumed.
- **MCP presence endpoint:** Remove `/mcp/presence` unless a current caller is found. If retained for debugging, require MCP auth and return only the caller's own presence.
- **Local proxy secret:** Use a local-only header when the client config supports it: `X-Slashtalk-Proxy-Token`. Do not use query tokens. MCP/OAuth guidance forbids access tokens in URLs, and even though this is not the Slashtalk access token, keeping secrets out of URLs avoids logs/history/referrer leakage. If a supported client cannot provide headers, use a random path segment fallback and strip it before forwarding.
- **DCR/token endpoint limits:** Add lightweight in-memory limits matching the existing single-node posture. Document gateway-level global/IP abuse handling as a deployment concern, but do not rely only on the gateway for local/dev behavior.

## Affected Files

- `apps/server/src/db/schema.ts`
- `apps/server/drizzle/*`
- `docs/generated/db-schema.md`
- `apps/server/src/auth/sessions.ts`
- `apps/server/src/auth/middleware.ts`
- `apps/server/src/auth/github.ts`
- `apps/server/src/managed-agent-sessions/routes.ts`
- `apps/server/src/oauth/mcp.ts`
- `apps/server/src/mcp/routes.ts`
- `apps/desktop/src/main/installMcp.ts`
- `apps/desktop/src/main/localMcpProxy.ts`
- `apps/desktop/test/installMcp.test.ts`
- `apps/desktop/test/localMcpProxy.test.ts`
- `apps/server/test/managed-agent-sessions.test.ts`
- `apps/server/test/mcp.test.ts`
- `apps/server/test/refresh.test.ts`
- `apps/server/test/user-repo-claim.test.ts`
- `docs/SECURITY.md`
- `docs/RELIABILITY.md`
- `docs/manual-tests/mcp-local-proxy.md`
- `docs/manual-tests/mcp-oauth-final.md`

## Implementation Units

### U1 — Revocation-aware JWT auth

Files:

- `apps/server/src/db/schema.ts`
- `apps/server/drizzle/*`
- `docs/generated/db-schema.md`
- `apps/server/src/auth/sessions.ts`
- `apps/server/src/auth/middleware.ts`
- `apps/server/src/auth/github.ts`
- `apps/server/test/refresh.test.ts`
- `apps/server/test/user-repo-claim.test.ts`

Plan:

- Add `users.credentials_revoked_at` nullable timestamp.
- Include `iat` in issued JWT payloads.
- In `revokeAllUserCredentials`, set `credentials_revoked_at = now()` in the same transaction as refresh/API/MCP token revocation.
- In `jwtAuth`, reject JWTs whose `iat` is older than `credentials_revoked_at`.
- Preserve normal `/auth/logout` behavior: it revokes only the presented refresh token and must not bump `credentials_revoked_at`.

Test scenarios:

- `logout-everywhere` rejects a previously valid JWT on `/api/me/setup-token`.
- `logout-everywhere` prevents old JWT from minting a new device API key through `/v1/auth/exchange`.
- GitHub grant revocation path bumps `credentials_revoked_at` and invalidates old JWTs.
- Normal `/auth/logout` does not invalidate another current JWT for the same user.
- New login after global revoke issues a JWT accepted by `jwtAuth`.

### U2 — Managed-agent data boundary and session-id ownership

Files:

- `apps/server/src/db/schema.ts`
- `apps/server/drizzle/*`
- `docs/generated/db-schema.md`
- `apps/server/src/managed-agent-sessions/routes.ts`
- `apps/server/test/managed-agent-sessions.test.ts`
- `packages/shared/src/index.ts`

Plan:

- Replace global unique `agent_sessions_session_id_key` with a unique index on `(user_login, session_id)`.
- Change the upsert conflict target to `[agentSessions.userLogin, agentSessions.sessionId]`.
- Make GET self-only: ignore or reject `userLogin` values that differ from `user.githubLogin`. Prefer `403` so accidental callers notice the contract change.
- Tighten `mode` validation to `t.Union([t.Literal("cloud"), t.Literal("local")])`.
- Keep the response shape camelCase because the migrated desktop and shared package already use it.

Test scenarios:

- Alice and Bob can upsert the same `sessionId` without overwriting each other.
- Alice cannot list Bob's managed-agent sessions via `?userLogin=bob`.
- Alice can list her own team-visible sessions.
- Private rows remain excluded from list responses.
- Invalid `mode` is rejected with `400`.
- Tests arrange their own rows and do not depend on prior test state.

### U3 — Atomic OAuth credential consumption

Files:

- `apps/server/src/oauth/mcp.ts`
- `apps/server/test/mcp.test.ts`

Plan:

- Refactor authorization-code exchange to transactionally consume a code with a conditional `UPDATE` that checks hash, unused state, and expiry.
- Refactor refresh-token rotation to transactionally consume a refresh token with a conditional `UPDATE` that checks hash, unrevoked state, and expiry.
- Insert replacement tokens in the same transaction.
- Keep existing error responses and audit event names.

Test scenarios:

- Two concurrent exchanges for the same authorization code result in exactly one success.
- Two concurrent refreshes for the same refresh token result in exactly one success.
- Replayed auth code remains `invalid_grant`.
- Replayed refresh token remains `invalid_grant`.
- Client/resource mismatch behavior remains unchanged.

### U4 — MCP presence endpoint hardening

Files:

- `apps/server/src/mcp/routes.ts`
- `apps/server/test/mcp.test.ts`
- `docs/SECURITY.md`

Plan:

- Check whether anything calls `/mcp/presence`. If there is no caller, remove the route.
- If kept, require `authenticateMcpRequest` and only return the authenticated user's own presence snapshot.
- Keep root `/mcp` auth rejection behavior unchanged.

Test scenarios:

- Unauthenticated `GET /mcp/presence` no longer returns all presence.
- If retained, valid auth returns only the caller's presence.
- Existing MCP initialize/list tests continue to pass.

### U5 — Local proxy admission control and disconnect cleanup

Files:

- `apps/desktop/src/main/installMcp.ts`
- `apps/desktop/src/main/localMcpProxy.ts`
- `apps/desktop/test/installMcp.test.ts`
- `apps/desktop/test/localMcpProxy.test.ts`
- `docs/manual-tests/mcp-local-proxy.md`
- `docs/SECURITY.md`

Plan:

- Generate a random local proxy secret in the desktop main process and persist it with safeStorage.
- Install the proxy secret as a client header where supported: `X-Slashtalk-Proxy-Token`.
- Require that header in `localMcpProxy.ts` before injecting the Slashtalk API key.
- Strip local-only proxy headers before forwarding upstream.
- Use `AbortController` for each forwarded request. Abort upstream fetch when the incoming request/response closes, and cancel the upstream reader in a `finally` block.
- If Codex or Claude config support differs, keep one tested install path per client. Prefer header config; use random path fallback only where header config is not supported.

Test scenarios:

- Requests missing `X-Slashtalk-Proxy-Token` are rejected locally and do not reach upstream.
- Requests with the wrong proxy secret are rejected locally and do not reach upstream.
- Requests with the right proxy secret still inject the real API key upstream.
- The local proxy header is not forwarded to the server.
- Client disconnect aborts the upstream fetch/stream.
- Config writer tests assert Claude and Codex entries include the local proxy admission secret in the chosen shape and still contain no Slashtalk API key.

### U6 — OAuth metadata and public endpoint abuse limits

Files:

- `apps/server/src/oauth/mcp.ts`
- `apps/server/test/mcp.test.ts`
- `docs/RELIABILITY.md`
- `docs/manual-tests/mcp-oauth-final.md`

Plan:

- Serve `/.well-known/oauth-protected-resource/mcp` with the same metadata as `/.well-known/oauth-protected-resource`.
- Add app-level request limits for `/oauth/register` and `/oauth/token`.
- Rate-limit dimensions should be simple and predictable: remote IP when available, plus `client_id` for token requests when provided.
- Return OAuth-shaped errors where practical and emit audit logs for rate-limited token/register attempts.

Test scenarios:

- `GET /.well-known/oauth-protected-resource/mcp` returns metadata for `resource: <origin>/mcp`.
- Claude/Codex-discovered metadata endpoints still pass existing tests.
- Registration limit rejects excessive requests and does not create unbounded rows.
- Token endpoint limit rejects excessive invalid exchanges without changing successful exchange behavior.

## Sequencing

1. Apply schema changes first: `credentials_revoked_at` and `(user_login, session_id)` uniqueness.
2. Implement U1 and U2 with failing tests first, because they close the highest-risk auth and cross-user data boundaries.
3. Implement U3 atomic OAuth consumption and concurrency tests.
4. Remove or protect `/mcp/presence`.
5. Implement local proxy secret and disconnect cleanup.
6. Add metadata alias and public OAuth endpoint limits.
7. Refresh docs and manual runbooks.
8. Run the full touched-workspace verification set.

## Manual Verification

After automated tests pass, rerun the same real-client checks from the consolidation plan:

- Desktop local proxy mode with Claude Code using the installed `slashtalk-mcp` entry.
- Direct Claude OAuth against `http://localhost:10000/mcp`.
- Direct Codex OAuth against `http://localhost:10000/mcp`.
- Sign-out-everywhere followed by reconnect attempts from both clients.

Additional manual checks:

- Confirm a local request to `http://127.0.0.1:37613/mcp` without the proxy secret fails before reaching the server.
- Confirm Claude/Codex still connect through the desktop-installed local proxy after reinstalling MCP config.
- Confirm server logs no longer expose public `/mcp/presence` snapshots.

## Verification Commands

From repo root:

```sh
bun --filter @slashtalk/server typecheck
bun --filter @slashtalk/server test
bun --filter @slashtalk/electron typecheck
bun --filter @slashtalk/electron lint
git diff --check
```

If `apps/server/src/db/schema.ts` changes:

```sh
cd apps/server
bun run db:generate
bun run gen:db-schema
```

## Out of Scope

- Adding real MCP tools or restoring `share_workspace`.
- Reintroducing cross-user managed-agent reads before `agent_sessions` has repo linkage.
- Removing legacy bearer compatibility.
- Replacing the in-memory single-node limiters with distributed Redis-backed limiters.
