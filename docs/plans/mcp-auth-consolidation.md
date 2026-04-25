---
task: mcp-auth-consolidation
status: active
created: 2026-04-25
approved_by: user
approved_at: 2026-04-25
---

# Plan: MCP Auth Consolidation

## Agent-native audit

- **Can run the app locally:** yes. `README.md` documents local Postgres, Redis, `apps/server`, `apps/mcp`, and `apps/desktop`.
- **Can run tests/typechecks/linters:** yes, with caveat. Server tests require Postgres/Redis; desktop typecheck currently has an existing `InfoSession.source` mismatch.
- **Can create branches, commits, PRs, and read PR comments:** yes. Git is available and the GitHub connector is installed.
- **Can view logs:** local logs yes through terminal. Production logs are not available from the current tools; this is a deployment-readiness gap.
- **Can take UI screenshots:** likely possible once the Electron app is running, but no documented Playwright/screenshot harness exists; this is a repeatability gap.
- **Can access error tracking:** no Sentry/error-tracking connector or docs found; this is an observability gap.

## Goal

Make Slashtalk's MCP surface live in `apps/server` with a standards-aligned auth path that works for desktop-installed local clients now and remote OAuth-capable MCP clients later.

## Requirements

- Preserve today's working path: desktop signs in with GitHub, receives a Slashtalk device API key, and Claude Code can call MCP with `Authorization: Bearer <device-api-key>`.
- Move the functionality currently in `apps/mcp` into `apps/server` so API key validation, user identity, schema, deployment, and docs have one source of truth.
- Support Streamable HTTP MCP at `/mcp` from `apps/server`.
- Port managed-agent session APIs from `apps/mcp` to `apps/server` without weakening visibility semantics.
- Add a first-class local proxy design so Claude/Codex configs can avoid plaintext long-lived bearer tokens.
- Add an OAuth design for direct remote MCP clients using MCP Protected Resource Metadata, OAuth 2.1 auth code + PKCE, RFC 8707 resource binding, and short-lived MCP access tokens.
- Emit spec-compliant `WWW-Authenticate` headers on 401 responses from `/mcp` so clients can discover the Protected Resource Metadata URL and recover automatically. This is how clients find the auth server in the first place; silent 401s break discovery.
- Decide and document the public-client registration model: either support OAuth Dynamic Client Registration, or pre-register a small set of well-known public clients (Claude Code, Codex) and reject unknown clients explicitly. Without one of these, per-machine MCP clients cannot self-register.
- Add structured auth audit logs: token issuance, token rejections (with reason — expired, wrong audience, insufficient scope, unknown client), revocations, and cross-user authorization denials in MCP tools. Closes the observability gap flagged in the agent-native audit.
- Cascade revocation when upstream credentials are invalidated: if a user revokes Slashtalk's GitHub OAuth grant or explicitly triggers sign-out-everywhere, invalidate all derived MCP OAuth tokens, refresh tokens, and device API keys for that user.
- Enforce `/mcp` rate limits before opening direct remote-client access: per-user request quotas and per-user concurrent MCP session caps in `apps/server`; IP/global abuse can remain a documented gateway-level concern.
- Use test-first implementation for protocol, auth, migration, and access-control behavior: write failing tests for each new `/mcp`, OAuth, revocation, rate-limit, and managed-agent-session contract before implementing the code. UI and real-client interop can use focused fixture/component tests plus explicit manual verification where full TDD is impractical.
- Provide manual test runbooks after each significant MCP phase. Each runbook must include the exact local commands to start Slashtalk services, the Claude Code/Codex config changes or install commands, the tool call to make, the server logs to watch, expected success/failure output, and rollback/reset steps. Manual user verification is part of done, not an optional follow-up.
- Keep existing route-prefix auth rules intact and update them deliberately: `/v1/*` uses API keys, `/api/*` and `/auth/*` use JWT cookies, `/ws` accepts JWT or API key, root `/mcp` is an explicit MCP resource-server exception because MCP protocol versioning happens in the initialize handshake, and new OAuth routes get their own explicit prefix/plugin.
- Keep cross-user data access rooted in verified `user_repos`; MCP tools must not create a new read path that bypasses those checks.
- Preserve existing tool descriptions and annotations on any ported tools — they are part of how hosts build safe approval behavior, not metadata to strip during refactor. The previous `share_workspace` test tool is intentionally not ported because it is unused. Add server instructions only if the consolidated SDK surface supports them and they are intentional. Any MCP tool that reads another user's sessions, events, feed, presence, or managed-agent sessions must have failing `user_repos` authorization tests before the tool is implemented or ported.
- Update `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`, and generated DB docs where behavior or schema changes.

## Constraints

- Bun remains the only package manager.
- `@slashtalk/shared` remains source-only.
- Drizzle migrations are append-only; `apps/mcp` SQL migrations cannot be copied by hand into metadata.
- No GitHub App model. User identity remains GitHub OAuth against the user's account.
- OAuth implementation must not ask GitHub for additional scopes just to authorize MCP.
- Static bearer headers may remain as a compatibility bridge, but should not be the long-term recommended remote-client path.
- Redis publication must continue through `RedisBridge`; no raw route-level Redis publishing.
- MCP stdio/local-proxy credentials should come from local environment or desktop secure storage, consistent with the MCP spec's stdio guidance.

## Approach

Do this in three deployable phases. First, collapse `apps/mcp` into `apps/server` while preserving current device API key behavior, because this removes the deployment/database split and makes the system simpler before adding new auth. Second, add a local proxy so local clients can avoid static tokens in config. Third, add standards-aligned MCP OAuth for direct remote clients.

Phase boundary:

- **Phase 1 — consolidation:** `apps/server` owns `/v1/managed-agent-sessions` and root `/mcp`, still authenticated by device API key. This phase is deployable on its own and removes the split `apps/mcp` service from the happy path.
- **Phase 2 — local proxy:** desktop installs Claude/Codex against a local MCP proxy so local clients do not need long-lived tokens in config. Legacy remote bearer config remains as an advanced escape hatch.
- **Phase 3 — remote OAuth:** after a real-client discovery spike, `apps/server` adds MCP OAuth metadata, token issuance, revocation, rate limits, and `/mcp` OAuth-token auth while preserving API-key compatibility for proxy/legacy clients.

External grounding:

- MCP Authorization says HTTP MCP auth is OAuth 2.1 based, protected MCP servers act as resource servers, servers must expose Protected Resource Metadata when auth is supported, clients must send bearer tokens on every HTTP request, and servers must audience-bind tokens to the MCP resource: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP Transports defines HTTP transport expectations for MCP request flow: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Claude Code supports remote HTTP MCP, bearer headers, OAuth login via `/mcp`, secure token storage/refresh, fixed callback ports, scope pinning, metadata override, and `headersHelper`: https://code.claude.com/docs/en/mcp
- Codex config supports MCP HTTP endpoints, static headers, bearer-token env vars, OAuth resource/scopes, callback settings, and configurable OAuth credential storage: https://developers.openai.com/codex/config-reference

## Affected files

- `apps/server/src/app.ts` — mount consolidated root `/mcp`, managed-agent-session, OAuth metadata, and OAuth token routes.
- `apps/server/src/mcp/*` — new server-owned MCP route/session-pool/tool modules ported from `apps/mcp/src`.
- `apps/server/src/managed-agent-sessions/*` — new server-owned managed-agent session routes.
- `apps/server/src/db/schema.ts` — add `agent_sessions` in the consolidation migration; add OAuth client/token/grant tables later after the real-client discovery spike fixes the registration model.
- `apps/server/drizzle/*` — separate generated append-only migrations for managed-agent sessions and OAuth tables.
- `apps/server/scripts/gen-db-schema.ts` output target `docs/generated/db-schema.md` — refresh after schema changes.
- `apps/server/src/auth/middleware.ts` — add a scoped MCP token auth plugin; preserve `jwtAuth`/`apiKeyAuth` semantics while adding audit logging where required.
- `apps/server/src/auth/oauth.ts` or `apps/server/src/oauth/routes.ts` — authorization-server metadata, consent/authorize, token exchange, refresh/revoke helpers.
- `apps/server/src/ws/redis-bridge.ts` — only if MCP presence needs Redis helper methods not already exposed.
- `docs/manual-tests/mcp-*.md` — new phase-specific manual test runbooks for consolidation, local proxy, OAuth discovery spike, and final OAuth interop.
- `apps/server/test/*` — add MCP auth, OAuth metadata/token, agent session, and access-control tests.
- `apps/desktop/src/main/installMcp.ts` — install either remote OAuth config, local proxy config, or legacy bearer config depending on user choice/support.
- `apps/desktop/src/main/selfSession.ts` — point desktop's own MCP client at consolidated server or local proxy.
- `apps/desktop/src/main/agentIngest.ts` — point `/v1/managed-agent-sessions` at `apps/server`.
- `apps/desktop/src/main/localMcpProxy.ts` — new local proxy process/server that injects secure auth and forwards to remote `/mcp`.
- `apps/desktop/src/shared/types.ts` and preload/renderer files — add install-mode settings and user-visible status if the UI exposes proxy/OAuth choices.
- `apps/mcp/*` — mark deprecated first, then delete once `apps/server` parity and desktop URLs are switched.
- `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`, `docs/QUALITY_SCORE.md` — update maps, auth model, security notes, reliability notes, and quality grades.

## Implementation steps

1. Document the target auth matrix in `docs/SECURITY.md`: current device API key bridge, root `/mcp` route-prefix exception, local proxy, and future direct MCP OAuth.
2. Add `agent_sessions` to Drizzle schema, generate the consolidation migration, and refresh `docs/generated/db-schema.md`.
3. Write failing tests for `/v1/managed-agent-sessions`: valid device API key, missing/invalid key, idempotent upsert, list filtering, and private-row non-exposure.
4. Port `apps/mcp/src/agent-sessions.ts` into `apps/server` under `/v1/managed-agent-sessions`, protected by existing `apiKeyAuth`, until the tests from step 3 pass.
5. Write failing tests for root `/mcp` API-key behavior: no bearer header, bad key, good key initialize, `mcp-session-id` reuse, and stale/unknown session handling.
6. Port the MCP Streamable HTTP server/session-pool into `apps/server/src/mcp`. Do not port the unused `share_workspace` test tool. Preserve descriptions and annotations for any future ported tools; do not strip them during a move. Add server instructions only if the consolidated SDK surface supports them and they are intentional. Implement until the tests from step 5 pass.
7. Audit the ported tool set against workflow-first MCP design: tool names as prompt surface, token budgets per tool, lightweight vs. full-detail variants for hot paths, and read/mutate separation for legible approval. For any current or future MCP tool that reads sessions, events, feed, presence, or managed-agent-session data across users, write failing `user_repos` authorization tests before implementation. Document the audit outcome inline (even if the answer is "current tools pass") so the inheritance is intentional rather than silent.
8. Protect root `/mcp` initially by mounting the existing `apiKeyAuth` plugin directly — no new compatibility layer, no parallel user-identity derivation. Update `core-beliefs`/docs to name `/mcp` as the explicit root-level MCP resource-server exception.
9. Port MCP presence/session tracking to a server-owned abstraction; if peers need cross-process visibility, back it with Redis TTL keys rather than in-process state.
10. Add `docs/manual-tests/mcp-consolidation.md` with commands to run local Postgres/Redis/server, configure Claude Code against local root `/mcp` with a test device API key, verify initialize/session behavior and an empty tool list, inspect server logs for auth/session events, verify managed-agent-session database state, and restore prior Claude config.
11. Run the consolidation manual test locally first, then give the runbook to the user and wait for their Claude/Codex verification feedback before calling Phase 1 done.
12. Update desktop MCP URLs and managed-agent ingest URLs to use the main server base URL by default.
13. Keep `apps/mcp` deployable but deprecated for one release; add logs/docs warning that new capability belongs in `apps/server`.
14. Write failing fixture tests for MCP install config writers: Claude Code local-proxy install, Claude Code legacy bearer install, Codex local-proxy install, and Codex no-hardcoded-token behavior.
15. Add a local proxy mode in desktop: a localhost or stdio MCP endpoint that forwards MCP traffic to remote `/mcp` and injects `Authorization` from Electron `safeStorage`.
16. Update Claude Code install flow to prefer local proxy mode for user-scoped local installs; keep legacy remote bearer install as an advanced compatibility option.
17. Add Codex install support as a separate config writer for `~/.codex/config.toml`, using env/header helper or local proxy rather than hardcoding the API key.
18. Add `docs/manual-tests/mcp-local-proxy.md` with Claude Code and Codex local-proxy setup, expected config diffs, expected proxy/server logs, sample tool calls, negative auth tests, and cleanup steps.
19. Run the local-proxy manual test locally first, then give the runbook to the user and wait for their Claude/Codex verification feedback before calling Phase 2 done.
20. Run a pre-implementation real-client OAuth discovery spike before creating OAuth tables/routes: install a tiny throwaway MCP route locally and verify Claude Code and Codex behavior for 401 `WWW-Authenticate`, Protected Resource Metadata, Dynamic Client Registration vs. static `client_id`, callback handling, requested scopes, and RFC 8707 `resource`. Record the observed quirks in the plan amendment log before step 21 is implemented.
21. Add `docs/manual-tests/mcp-oauth-discovery-spike.md` capturing the exact spike server command, Claude/Codex config or install commands, logs to watch, observed request/response sequence, and user-verification checklist.
22. Give the OAuth discovery runbook to the user and incorporate their independent Claude/Codex observations before choosing the registration model.
23. Write failing tests for OAuth metadata and registration behavior: Protected Resource Metadata, Authorization Server Metadata, `WWW-Authenticate` shape, unknown-client rejection, and DCR success if DCR is chosen.
24. Encode the chosen public-client registration model in schema/docs: either add Dynamic Client Registration tables/endpoints, or add static well-known-client rows/config with an explicit reject path for unknown `client_id`s.
25. Add OAuth schema tables after the discovery spike and registration-model decision: authorization codes, MCP access/refresh tokens or token hashes, client registrations/static clients, granted scopes, resource/audience binding, revocation metadata, and audit fields.
26. Add OAuth metadata endpoints on `apps/server`: Protected Resource Metadata for `/mcp` and OAuth Authorization Server Metadata, until the metadata tests from step 23 pass.
27. Write failing tests for OAuth authorization-code + PKCE and token exchange: invalid verifier, expired code, code reuse, wrong `resource`, missing scope, refresh rotation, and token revocation.
28. Add OAuth authorization-code + PKCE storage and routes with resource-bound MCP access tokens, refresh tokens, revocation, and short access-token TTLs, until the tests from step 27 pass.
29. Write failing tests for MCP OAuth token middleware: expired token, wrong audience/resource, insufficient scope, revoked token, malformed token, and fallback to legacy device API key.
30. Add MCP token auth middleware that validates issuer, expiry, audience/resource, user, and scopes, separate from `apiKeyAuth`. On rejection, return 401 with a spec-compliant `WWW-Authenticate` header pointing at the Protected Resource Metadata URL with the rejection reason (`error="invalid_token"`, `error_description=...`). Implement until the tests from step 29 pass.
31. Update `/mcp` auth to accept MCP OAuth tokens first, then device API keys only for local proxy/legacy compatibility.
32. Write failing tests for structured audit logs on token issuance, token rejection reason, client registration, revocation, and cross-user authorization denial inside an MCP tool.
33. Add structured auth audit logging across `apiKeyAuth`, MCP token middleware, and OAuth routes: emit events for token issuance, token rejection (with reason), client registration, revocation, and any cross-user authorization denial inside an MCP tool. Define a stable event schema so future log routing or SIEM ingestion does not require rework.
34. Write failing tests for revocation event scope: normal sign-out, device revoke, global revoke, and forced re-authentication of existing MCP sessions on next request.
35. Wire revocation by event scope:
    - Normal sign-out revokes only the presented refresh token and clears local desktop credentials; it does not revoke other devices or MCP OAuth grants.
    - Device revoke revokes that device's API key, any local-proxy sessions bound to it, and any MCP OAuth grants explicitly tied to that device/client if such binding exists.
    - Global revoke covers GitHub OAuth grant revocation and explicit sign-out-everywhere; it invalidates all user refresh tokens, MCP OAuth access/refresh tokens, and device API keys in one transaction.
    Add a manual sign-out-everywhere control surfaced via user account settings.
36. Write failing tests for `/mcp` rate limits: per-user request quota, per-user concurrent session cap, and successful requests below the cap.
37. Apply `/mcp` per-user request quotas and per-user concurrent MCP session caps in `apps/server`. Document gateway-level IP/global abuse handling in `docs/RELIABILITY.md`.
38. Add `docs/manual-tests/mcp-oauth-final.md` with full Claude Code and Codex OAuth setup, expected browser/login flow, expected token and tool-call logs, negative tests for revoked/wrong-resource tokens, and cleanup steps.
39. Run the final real-client OAuth interop check locally first, then give the runbook to the user and wait for their Claude/Codex verification feedback before approval: both clients must complete OAuth discovery, token exchange, and a sample tool call against consolidated `/mcp`.
40. Update desktop UI copy/settings for MCP install modes and token revocation/status.
41. Remove hosted `apps/mcp` from README local-dev instructions after server parity is verified; keep a migration note for existing deployments.
42. Run `bun --filter @slashtalk/server typecheck`, `bun --filter @slashtalk/server test`, `bun --filter @slashtalk/electron typecheck`, and targeted desktop lint/type checks after fixing any existing baseline failures or explicitly documenting them.

## User-facing surfaces

- **Copy:** MCP install mode labels:
  - "Recommended: Local proxy"
  - "Remote OAuth"
  - "Legacy bearer token"
  - "Local proxy keeps your Slashtalk credential out of Claude/Codex config."
  - "Remote OAuth lets this MCP client store and refresh its own access token."
  - "Legacy bearer token writes a long-lived device key into client config. Use only when the client does not support OAuth or local proxy."
- **Success state:** "Slashtalk MCP is installed for Claude Code." and "Slashtalk MCP is installed for Codex."
- **Error states:**
  - "Sign in to Slashtalk before installing MCP."
  - "Could not write MCP config: <reason>."
  - "MCP token was rejected. Sign in again or reinstall MCP."
  - "OAuth login expired. Start MCP login again."
  - "This MCP client requested access for the wrong resource."
- **Empty state:** "No MCP clients installed yet."
- **Loading state:** "Installing MCP..." and "Waiting for OAuth login..."
- **Security warning:** show the plaintext-token warning inline only for legacy bearer mode.

## Edge cases

- Claude/Codex config has an existing `slashtalk-mcp` entry → update only our entry and preserve unrelated config.
- API server and MCP URL point to different environments → consolidated server removes this for default installs; legacy custom URLs should show an explicit mismatch warning.
- Static token is stolen → user can revoke the device API key; OAuth tokens are short-lived and refresh tokens can be revoked.
- OAuth client omits `resource` → reject token exchange or fall back only if spec-compatible client behavior requires it; do not mint generic MCP tokens.
- OAuth token has correct issuer but wrong audience/resource → reject at root `/mcp` with `WWW-Authenticate` and `error="invalid_token"`, `error_description="resource mismatch"`.
- 401 without `WWW-Authenticate` → spec-compliant clients cannot discover Protected Resource Metadata. Every reject path must populate the header.
- Unknown OAuth `client_id` at the token endpoint → reject explicitly per the chosen registration model (DCR or well-known list); do not silently succeed.
- Normal sign-out → revoke only the presented refresh token and clear local desktop credentials; other devices and MCP OAuth grants keep working.
- Device revoke → revoke that device's API key plus any sessions/grants bound to that device; other devices keep working.
- GitHub OAuth grant revocation or explicit sign-out-everywhere → cascade revoke all refresh tokens, MCP access/refresh tokens, and device API keys for that user; existing MCP sessions terminate on next request.
- Client sends bearer in query string → reject; MCP spec requires Authorization header.
- Redis unavailable during MCP presence update → degrade like existing presence/WS soft-fail behavior.
- Multiple server replicas hold MCP sessions → avoid relying on in-memory presence for user-visible truth; use Redis if live status matters across replicas.
- Desktop safeStorage unavailable → local proxy cannot silently inject credentials; prompt re-sign-in or offer OAuth/legacy mode with warning.
- Codex config format changes → isolate config writing in one module and add a small fixture-based test.

## Acceptance criteria

- [ ] `apps/server` serves root `/mcp` as an explicit MCP resource-server exception to route-prefix auth rules and can handle MCP initialize/session requests with a valid Slashtalk device API key.
- [ ] `apps/server` owns `/v1/managed-agent-sessions`; desktop no longer defaults to `chatheads.onrender.com` for managed-agent-session ingest.
- [ ] `apps/mcp` is no longer required for local development or hosted deployment.
- [ ] Claude Code install works without writing a static bearer token when local proxy mode is selected.
- [ ] Codex install support exists and avoids hardcoding the device key in `~/.codex/config.toml`.
- [ ] OAuth Protected Resource Metadata and Authorization Server Metadata validate against MCP discovery expectations.
- [ ] `/mcp` returns 401 with a spec-compliant `WWW-Authenticate` header (including `resource_metadata` parameter) on every auth-rejection path.
- [ ] OAuth access tokens are short-lived, resource-bound to `/mcp`, scoped, and rejected when expired or audience-mismatched.
- [ ] Public-client registration model is implemented and documented — either Dynamic Client Registration succeeds end-to-end, or unknown `client_id`s are rejected against a maintained well-known list.
- [ ] Real-client interop verified: Claude Code and Codex each complete OAuth discovery, token exchange, and a sample tool call against the consolidated `/mcp`.
- [ ] Manual test runbooks exist for MCP consolidation, local proxy, OAuth discovery spike, and final OAuth interop; each includes startup commands, config edits/install commands, expected logs, sample tool calls, negative tests, and rollback/reset steps.
- [ ] Assistant-run manual checks and user-run Claude/Codex verification feedback are recorded before each MCP phase is marked done.
- [ ] Auth audit log emits structured events for token issuance, rejection (with reason), revocation, and cross-user denials in MCP tools.
- [ ] Protocol/auth/access-control behavior was implemented test-first: failing tests existed before implementation for managed-agent sessions, `/mcp` API-key auth, OAuth metadata, PKCE/token exchange, MCP token middleware, revocation, rate limits, and cross-user tool access.
- [ ] Normal sign-out revokes only the presented refresh token and local desktop credentials; it does not revoke other devices or MCP OAuth grants.
- [ ] Device revoke invalidates that device's API key and any sessions/grants bound to it without revoking other devices.
- [ ] GitHub OAuth grant revocation or explicit sign-out-everywhere invalidates that user's refresh tokens, MCP OAuth tokens, and device API keys in one cascade; existing MCP sessions are forced to re-authenticate.
- [ ] Sign-out-everywhere exists and is reachable from account settings.
- [ ] `/mcp` enforces per-user request quotas and per-user concurrent MCP session caps in `apps/server`, with gateway-level IP/global abuse handling documented.
- [ ] Legacy bearer-token mode remains available with explicit warning and revocation path.
- [ ] Cross-user MCP tools can only read data through existing `user_repos` authorization rules.
- [ ] Server and desktop typechecks pass, server tests pass, and docs reflect the new default architecture.

## Out of scope

- GitHub App installation flow: rejected because core-beliefs require user OAuth, not org-admin GitHub App consent.
- Repo-content access through MCP: rejected because current GitHub OAuth scopes do not include repo contents and Slashtalk's promise is session/presence sharing, not repository browsing.
- Full OpenID Connect identity provider implementation: rejected unless a client requires it; OAuth Authorization Server Metadata is enough for MCP discovery.
- Removing legacy bearer compatibility in the same change: rejected because it would strand current desktop-installed Claude Code configs.

## Plan amendments

- **2026-04-25 — MCP wiki review pass.** Reviewed the plan against the wiki's MCP knowledge cluster (GitHub remote-MCP security guide, MCP Client Best Practices, Block's playbook, Lowin, Kohlleffel). Added requirements, steps, edge cases, and acceptance criteria for: spec-compliant `WWW-Authenticate` on 401, an explicit decision on Dynamic Client Registration vs. well-known clients, structured auth audit logging, GitHub-grant/global-revoke cascade, per-user `/mcp` quota and concurrent-session caps, preservation of tool descriptions/annotations during port, a workflow-first tool-surface audit, real-client OAuth interop checks, and simplification of the first `/mcp` port to mount `apiKeyAuth` directly on root `/mcp` as an explicit route-prefix exception before OAuth lands.
- **2026-04-25 — Refine pass.** Split the implementation into deployable phases, separated the `agent_sessions` migration from OAuth schema migrations, and moved the real-client OAuth discovery spike before OAuth table/route design so Claude Code and Codex behavior informs the registration model instead of being validated only at the end.
- **2026-04-25 — TDD refinement.** Added test-first requirements and reordered implementation so each protocol/auth/access-control slice starts with failing tests before code changes. Scoped TDD to server contracts and config-writer fixtures while keeping real Claude Code/Codex interop as explicit manual acceptance.
- **2026-04-25 — Manual QA refinement.** Added phase-specific MCP manual test runbooks and made assistant-run plus user-run Claude/Codex verification part of the done criteria after each significant MCP phase.
- **2026-04-25 — Migration scope refinement.** Dropped the unused `share_workspace` test tool from Phase 1 consolidation; `/mcp` migration now verifies transport/auth/session behavior with an empty tool list until real MCP tools are added later.
- **2026-04-25 — Phase 2 local proxy implementation.** Added desktop-local MCP proxy support and config-writer fixtures for Claude Code and Codex. Local installs now default to `http://127.0.0.1:37613/mcp` without static bearer material; the proxy injects the safeStorage-backed device API key per request. Legacy Claude bearer install remains as an explicit compatibility mode.

## Three questions

1. **What was the hardest decision?** Whether to implement OAuth first or consolidate first. Consolidation first is safer because current MCP auth already depends on the server's `api_keys` table; moving it into `apps/server` removes environment mismatch before adding more auth surface.
2. **What alternatives were rejected, and why?** A desktop-only local proxy as the final answer was rejected because it cannot serve cloud MCP clients or direct remote Claude/Codex flows. Static bearer headers as the final answer were rejected because they leave a long-lived credential in client config. A separate OAuth server was rejected because Slashtalk already has user/session/token infrastructure in `apps/server`.
3. **What are you least confident about?** Client interoperability details between Claude Code and Codex OAuth are the least certain; both document OAuth-related MCP settings, but exact discovery quirks should be verified with local manual login tests before removing any compatibility path.
