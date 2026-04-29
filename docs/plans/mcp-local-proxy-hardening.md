---
task: mcp-local-proxy-hardening
status: draft
created: 2026-04-29
origin: 2026-04-29 architecture review (life-wiki/mcp-bridge-shim)
---

# Plan: MCP Local Proxy Hardening

A focused follow-up to [`mcp-auth-review-hardening`](mcp-auth-review-hardening.md). Three small, independent fixes on the desktop's local MCP proxy: eliminate the hardcoded `127.0.0.1:37613`, upgrade the fallback proxy-secret crypto, and make the "Slashtalk not running" failure mode less opaque to Claude Code / Codex users. The work is bounded, ships in one PR, and is meant as production-hygiene closure on the local-proxy work — not a new feature.

## Goal

Three targeted hardenings in `apps/desktop/src/main/{localMcpProxy,installMcp}.ts`, after which: two slashtalk installs on the same machine never collide on a port; a Claude Code session attached through the proxy survives a desktop restart and reconnects to the same URL; the fallback proxy secret is uniformly cryptographically strong; and Claude Code / Codex users see a useful hint when the desktop app is offline (or, if no client surface for that exists, the runbook documents the recovery step).

## Requirements Trace

- **R1 — No hardcoded local port.** Two slashtalk installs (test build + main, two devs sharing a box) must coexist without colliding on `127.0.0.1:37613`.
- **R2 — Bound port persists across desktop restarts.** A Claude Code / Codex session attached through the proxy must reconnect to the same URL after a desktop relaunch, without the user re-running install.
- **R3 — Graceful collision recovery.** If a previously-saved port is taken on relaunch (rare but possible), the proxy must fall back to port-zero, persist the new port, and refresh any installed client config so it points at the new URL — not crash, not silently leave a stale config.
- **R4 — Installed config matches reality.** `~/.claude.json` and `~/.codex/config.toml` always reflect the actually-bound URL, never a stale port. The installer never reads `localMcpPort()` directly.
- **R5 — Fallback secret strength uniformity.** The fallback proxy secret in `installMcp.ts` matches the production-path strength (`randomBytes(32).toString("base64url")`). No code path hands out a UUID-strength secret as auth.
- **R6 — Useful "not running" hint.** When the desktop app is offline, Claude Code / Codex users see a hint pointing at "start Slashtalk Desktop" instead of a raw transport error, _if_ the client surfaces any custom field from its installed config at connect time. If no such field exists, document the recovery step in `docs/manual-tests/mcp-local-proxy.md`.

## Decisions

- **Port persistence in userData store, not safeStore.** New `store.ts` key (`localMcpProxyPort`) in the existing Electron `app.getPath('userData')` JSON store, helper module `localMcpProxyPort.ts`. The port is not a secret, so encrypting it would make restart stability depend on OS keyring availability. The proxy secret stays in `safeStore`; the port does not.
- **Proxy owns the URL.** `mcpProxy.url()` becomes the single source of truth for the live proxy URL. `installMcp.configureInstaller({ localProxyUrl: mcpProxy.url, ... })` wires it through the existing DI seam in `installMcp.ts:31-35`. Direct calls to `localMcpPort()` and `localProxyMcpUrl()` are removed from the install path.
- **Reconcile installed configs after proxy start.** On every successful proxy start, inspect currently-installed Claude Code / Codex entries and rewrite local-proxy entries whose URL differs from `mcpProxy.url()`. This handles both collision fallback and the first upgrade from the old hardcoded `37613`. Legacy-bearer Claude entries are detected and left unchanged.
- **`port-changed` is a secondary signal, not the only refresh trigger.** The proxy may still emit `port-changed` for observability and tests, but correctness comes from the post-start reconcile step. This avoids missing a start-time event because a listener was attached too late.
- **`mcp:url` IPC awaits proxy ready.** If the renderer asks for the URL before bind completes, the IPC awaits the start promise rather than returning a stale or undefined URL. Same defensive guard on `mcp:install`. The start promise must keep rejecting on bind failure; logging must not turn a failed proxy start into a successful install.
- **Fallback secret crypto.** `installMcp.ts:64`: replace `crypto.randomUUID()` with `randomBytes(32).toString("base64url")` to match `localMcpProxySecret.ts:17`.
- **R6 strategy: docs fallback.** U6 research found no supported config-rendered offline hint field for Claude Code or Codex. Do not write speculative keys into client config; document recovery and capture observed client error text during manual verification.
- **Env override preserved.** `SLASHTALK_LOCAL_MCP_PORT` continues to act as a manual pin (used in tests, dev workflows). When set, it overrides persistence — the user has explicitly asked for a fixed port. The proxy port precedence is: explicit `deps.port` in tests, `SLASHTALK_LOCAL_MCP_PORT` if set, saved port, then port-zero (`0`). `DEFAULT_LOCAL_MCP_PORT = 37613` is removed; the new default is port-zero.

## Affected Files

- `apps/desktop/src/main/config.ts` — Replace `DEFAULT_LOCAL_MCP_PORT = 37613` with `0`. Document the new semantics in the file header comment.
- `apps/desktop/src/main/localMcpProxy.ts` — Port-zero binding with persisted preferred port, EADDRINUSE retry on the saved port, accurate `url()` after rebind, `port-changed` event emission.
- `apps/desktop/src/main/localMcpProxyPort.ts` (new) — Persisted-port helper, backed by plain `store.ts` userData state.
- `apps/desktop/src/main/installMcp.ts` — Drop direct calls to `localMcpPort()` / `localProxyMcpUrl()` from the install path; rely entirely on the `localProxyUrl` dep. Tighten the fallback secret. Ensure no unsupported R6 hint fields are written.
- `apps/desktop/src/main/index.ts` — Create `mcpProxy` before configuring the installer; wire `mcpProxy.url` into `installMcp.configureInstaller` as `localProxyUrl`; attach any `port-changed` listener before start; run post-start config reconciliation for installed local-proxy targets; make `mcp:url` and `mcp:install` IPCs await proxy start.
- `apps/desktop/test/installMcp.test.ts` — New tests: install reads URL from `localProxyUrl` dep, never touches `localMcpPort()`. New fallback-secret strength assertion (32 bytes base64url ⇒ 43 chars).
- `apps/desktop/test/localMcpProxy.test.ts` — New tests: persisted port reused on second start; EADDRINUSE on saved port triggers port-zero fallback; `url()` always reflects the live bound port.
- `apps/desktop/test/localMcpProxyPort.test.ts` (new) — Unit tests for the persistence helper (load/save/missing/corrupted).
- `docs/manual-tests/mcp-local-proxy.md` — Add restart-survives-attached-Claude scenario; if R6 falls back to docs, document the "is Slashtalk Desktop running?" recovery step.
- `docs/SECURITY.md` — Note the secret-strength uniformity (one-line update under the existing local-proxy section).

## Implementation Units

### U1 — Persisted-port helper

Files: `apps/desktop/src/main/localMcpProxyPort.ts` (new), `apps/desktop/test/localMcpProxyPort.test.ts` (new).

Plan:

- Use `store.ts` directly, not `safeStore`: cached module-level value, read from `store.get` on first access, save with `store.set` after a successful bind.
- Export `getSavedLocalMcpPort(): number | null` and `saveSavedLocalMcpPort(port: number): void`.
- Treat any non-integer / out-of-range value from the store as "no saved port."

Test scenarios:

- First call returns `null` when nothing is saved.
- After `saveSavedLocalMcpPort(54321)`, next `getSavedLocalMcpPort()` returns `54321`.
- Corrupted store value returns `null` and clears the corrupt entry.
- `safeStorage` unavailable does not affect port persistence because the port is not encrypted.

### U2 — Port-zero binding + EADDRINUSE fallback in localMcpProxy

Files: `apps/desktop/src/main/localMcpProxy.ts`, `apps/desktop/src/main/config.ts`, `apps/desktop/test/localMcpProxy.test.ts`.

Plan:

- `config.ts`: change `DEFAULT_LOCAL_MCP_PORT` from `37613` to `0`. Update the header comment and the `localMcpPort()` validator to allow `0`, or add a separate `localMcpPortOverride(): number | null` helper so the proxy can distinguish "no env override" from "env explicitly set to 0."
- `localMcpProxy.ts`:
  - At construction, accept a `getSavedPort: () => number | null` and `saveBoundPort: (port: number) => void` dep (defaulted to the helper from U1).
  - In `start()`: choose the preferred port in this order: `deps.port` if supplied, env override if set, saved port if present, otherwise `0`. Attempt `listen(preferredPort, "127.0.0.1")`. On `EADDRINUSE` for a saved/default port, fall back to `listen(0, "127.0.0.1")`; on `EADDRINUSE` for an explicit `deps.port` or env override, propagate so tests/dev pins fail loudly. On any other error, propagate.
  - After successful bind, capture `addr.port`; if it differs from `savedPort`, call `saveBoundPort(addr.port)` and emit a `port-changed` event.
  - Expose `on("port-changed", listener)` and `off(...)` via Node's `EventEmitter`. Keep the `LocalMcpProxy` interface backward-compatible by extending it with `on` / `off`, not by changing existing method signatures.
- Remove `localProxyMcpUrl()` from `localMcpProxy.ts`. `url()` must always return `http://127.0.0.1:${boundPort}/mcp` from the actual bound port. If called before start, throw a clear error rather than returning the default or a stale URL.

Test scenarios:

- First start with no saved port: binds port-zero, persists the chosen port.
- Second start with a saved port: reuses the saved port if free.
- Saved port is taken (simulate by binding it on a sentinel server): proxy falls back to port-zero, persists the new port, emits `port-changed`.
- `start()` then `stop()` then `start()` reuses the same persisted port (no churn).
- `url()` reflects the bound port at all observation points.

### U3 — Installer URL-source rewire + fallback secret upgrade

Files: `apps/desktop/src/main/installMcp.ts`, `apps/desktop/test/installMcp.test.ts`.

Plan:

- Replace `defaultLocalProxySecret`'s `crypto.randomUUID()` with `randomBytes(32).toString("base64url")`. Import `randomBytes` from `node:crypto` at the top of the file.
- Remove the file-level `localProxyMcpUrl()` export and the implicit `localMcpPort()` dependency from the install path. The default for `localProxyUrl` becomes a no-op stub that throws if never injected — install must be configured before use. (Or: leave a defensive default that returns a clearly-broken sentinel URL. Prefer throw-on-missing for correctness.)
- Re-export `localProxyMcpUrl` only if external callers still need it; grep first to confirm.
- Verify `mcpUrl()` and `remoteMcpUrl()` exports still work — these are called from `index.ts:247` IPC handler and elsewhere.

Test scenarios:

- `install("claude-code", { mode: "local-proxy" })` writes the URL returned by the injected `localProxyUrl` dep, regardless of any env-var port pin.
- Without `configureInstaller` having been called, install throws or returns a typed error (whichever is the ergonomic choice — pin in implementation).
- Fallback secret strength: when `localProxySecret` is _not_ injected, the secret used in the written config decodes from base64url to exactly 32 bytes. Length assertion (43 base64url chars).
- All existing `installMcp.test.ts` cases continue to pass.

### U4 — Post-start config reconciliation

Files: `apps/desktop/src/main/index.ts`.

Plan:

- Add an installer inspection helper that can distinguish:
  - not installed
  - Claude Code legacy-bearer install (`headers.Authorization` or remote URL)
  - Claude Code local-proxy install (`headers.X-Slashtalk-Proxy-Token`)
  - Codex local-proxy install
  - current configured URL for local-proxy installs
- After `mcpProxy.start()` succeeds, call a reconcile helper:
  - If a target has a local-proxy install and its URL differs from `mcpProxy.url()`, call `installMcp.install(target, { mode: "local-proxy" })`.
  - If a Claude Code target is legacy-bearer, leave it unchanged.
  - If a target is not installed, leave it unchanged.
- Attach any `port-changed` listener before start, but treat it as a log/test signal. The reconcile step is the correctness mechanism because it catches first upgrade from hardcoded `37613`, missed events, and rare fallback changes.
- Failures during reconciliation are logged but do not crash the desktop app. `mcp:install` remains gated by proxy readiness and should still fail if the proxy never started.

Test scenarios:

- Manual: install MCP for Claude Code, kill the desktop process, occupy the saved port from another process, restart desktop, observe that `~/.claude.json` is updated to the new port.
- Automated: installer inspection identifies legacy-bearer Claude entries and does not reinstall them as local-proxy.
- Automated or manual: first launch after upgrade rewrites an existing local-proxy config from `http://127.0.0.1:37613/mcp` to the live `mcpProxy.url()` even when no `port-changed` event is observed.

### U5 — IPC wait-for-ready

Files: `apps/desktop/src/main/index.ts`.

Plan:

- Replace the eager `void mcpProxy.start().catch(...)` at line 356 with a captured `Promise<void>` that keeps rejection semantics:
  - `const mcpProxyReady = mcpProxy.start();`
  - `void mcpProxyReady.catch((err) => console.warn(...));`
- `ipcMain.handle("mcp:url", async () => { await mcpProxyReady; return installMcp.mcpUrl(); })`.
- `ipcMain.handle("mcp:install", async (_e, target, options) => { await mcpProxyReady; return installMcp.install(target, options as ...); })`.
- `mcp:status` and `mcp:uninstall` do not need the gate — they read/write client config files only.

Test scenarios:

- (Manual) Open the desktop app, immediately call `mcp:install` from devtools — observe the install completes, the URL written matches the live bound URL.
- (Automated coverage is thin here; the gate is a defensive measure and the units it depends on are independently tested.)

### U6 — "Slashtalk not running" recovery docs

Files: `apps/desktop/src/main/installMcp.ts`, `docs/manual-tests/mcp-local-proxy.md`.

Plan:

- **Verdict:** no supported config-rendered hint field found for Claude Code or Codex. Do not add speculative `description`, `displayName`, or custom keys to installed config.
- Claude Code docs show HTTP entries using `type`, `url`, `headers`, `oauth`, and `headersHelper`, and `/mcp` status/retry behavior, but no documented server-description field that appears on connection failure.
- The local `@anthropic-ai/claude-agent-sdk` MCP config types for HTTP/SSE expose only `type`, `url`, `headers`, and optional tool policy. Status includes an `error` field produced by the client, not a static config hint.
- Codex's generated JSON Schema has `additionalProperties: false` on `RawMcpServerConfig` and does not accept `description` or `displayName`. It accepts a legacy `name` field, but the schema labels it as a display-name compatibility field, not an error hint; do not rely on it for recovery guidance.
- Implement the fallback path:
  - Document the verdict in `docs/manual-tests/mcp-local-proxy.md` under a new "Recovery: ECONNREFUSED on slashtalk-mcp" section explaining that the desktop app must be running for MCP to work, with steps to verify and restart.
  - Add a one-line note to `docs/SECURITY.md` acknowledging that clients do not expose a supported per-server offline hint field today.
  - Optional manual check: stop Slashtalk Desktop, open Claude Code `/mcp` and Codex `/mcp`, and record the observed raw client error text in the manual test doc.

Test scenarios:

- No unsupported hint fields are written to `~/.claude.json` or `~/.codex/config.toml`.
- `docs/manual-tests/mcp-local-proxy.md` contains the `ECONNREFUSED` recovery section.

### U7 — Tests + docs refresh

Files: `apps/desktop/test/*` (covered above), `docs/manual-tests/mcp-local-proxy.md`, `docs/SECURITY.md`.

Plan:

- Update `docs/manual-tests/mcp-local-proxy.md`:
  - Add: "Desktop restart preserves Claude Code MCP connection" — install MCP, attach Claude, restart desktop, verify Claude's MCP server reconnects without re-install.
  - Add: "Recovery: ECONNREFUSED on slashtalk-mcp" — short procedure pointing at "is the desktop app running?" and recording the observed Claude Code / Codex offline error text.
- Update `docs/SECURITY.md`:
  - One line under the local proxy section: fallback proxy secret now matches the production-path strength (32 random bytes, base64url-encoded).

## Sequencing

1. **U1** — persistence helper. No deps.
2. **U2** — port-zero binding in proxy. Depends on U1.
3. **U3** — installer rewire + fallback secret. Depends on U2 (`mcpProxy.url()` is the new source of truth).
4. **U4** — post-start config reconciliation. Depends on U3.
5. **U5** — IPC wait-for-ready. Independent, can land alongside U4.
6. **U6** — docs fallback and manual error-text capture. Independent of 1–5; can run in parallel during U2/U3 if a second session is available.
7. **U7** — docs refresh, tests cleanup. Lands last to capture U6's verdict.

## User-facing surfaces

The work is mostly internal — no copy or UI in the slashtalk desktop app changes. U6 does not add client-config copy because no supported renderable field was found:

- **Target audience:** Claude Code / Codex users encountering a connection failure to slashtalk-mcp.
- **Surface:** runbook entry in `docs/manual-tests/mcp-local-proxy.md` titled _"Recovery: ECONNREFUSED on slashtalk-mcp"_.
- **Copy:** no client-terminal copy is installed. The runbook should point users at starting Slashtalk Desktop and verifying the local proxy URL.
- **Manual evidence:** record the raw Claude Code and Codex offline error text during verification.

## Edge cases

- **Saved port file corrupted / unreadable.** The port helper validates the stored value, clears invalid data, treats it as "no saved port," and falls through to port-zero.
- **`safeStorage` unavailable on Linux without keyring.** Port persistence still works because the port is stored in plain userData state. The proxy secret still does not persist without safeStorage; this is existing credential behavior and should remain documented.
- **`SLASHTALK_LOCAL_MCP_PORT` env var set.** Manual pin overrides persistence. Existing semantics preserved; pinned port takes precedence over saved port and over port-zero default. If the pinned port is occupied, startup fails loudly instead of silently ignoring the user's explicit pin.
- **Two slashtalk processes started concurrently with the same userData dir.** Second one gets `EADDRINUSE` on the saved port, falls back to port-zero, persists the new port — last-writer-wins on the persisted entry. This is a degenerate case (one userData per user, normal multi-install uses separate userData paths via electron-vite naming); acceptable, documented in `docs/manual-tests/mcp-local-proxy.md`.
- **Renderer asks for `mcp:url` while proxy is starting.** U5's gate awaits the start promise. Worst-case latency: hundreds of milliseconds at app launch.
- **User signed into Slashtalk but desktop crashed.** Persisted port file remains, but no proxy is bound. Claude Code gets `ECONNREFUSED` — exactly the case U6 targets.
- **Existing installs with hardcoded URL `http://127.0.0.1:37613/mcp`.** Auto-handled by U4's post-start reconcile: if the installed entry is local-proxy mode and its URL differs from the live proxy URL, reinstall just that local-proxy entry with the current URL.
- **Existing installs with `legacy-bearer` mode.** Mode unchanged by this work; legacy-bearer path bypasses the local proxy entirely. U4 must detect and skip these entries rather than converting them to local-proxy.

## Acceptance criteria

A testable checklist; "done" is defined by all of these being green.

- [x] `bun --filter @slashtalk/electron typecheck` passes.
- [x] `bun --filter @slashtalk/electron test` passes (existing + new tests).
- [x] `bun --filter @slashtalk/electron lint` passes.
- [x] `git diff --check` clean.
- [ ] No call to `localMcpPort()` remains in the install path of `installMcp.ts`. (`grep`-able assertion.)
- [ ] Fallback secret in `installMcp.ts` uses `randomBytes(32).toString("base64url")`. (`grep`-able assertion.)
- [ ] `mcpProxy.url()` returns the actual bound port and throws clearly before start instead of returning a default/stale URL.
- [ ] `SLASHTALK_LOCAL_MCP_PORT` wins over saved port; if the pinned port is occupied, proxy startup fails loudly.
- [ ] First launch after upgrade rewrites an existing local-proxy config from `http://127.0.0.1:37613/mcp` to the live proxy URL.
- [ ] Existing Claude Code `legacy-bearer` installs are not converted to local-proxy by reconciliation.
- [ ] If proxy startup fails, `mcp:install` does not write a local-proxy config pointing at a dead URL.
- [ ] Manual: install MCP for Claude Code, attach a Claude Code session, restart Slashtalk Desktop, observe that the Claude session's `slashtalk-mcp` server reconnects on its own without re-running install.
- [ ] Manual: launch Slashtalk Desktop with the saved port artificially occupied (e.g. `nc -l <saved_port>` from another terminal), observe that the desktop app starts, picks a different port, rewrites `~/.claude.json`, and the new URL is reachable.
- [ ] Manual: stop Slashtalk Desktop, run Claude Code and Codex, observe the offline error text, and confirm the runbook recovery steps work.
- [ ] `docs/manual-tests/mcp-local-proxy.md` includes the restart-preserves-connection scenario and the ECONNREFUSED recovery scenario.
- [ ] `docs/SECURITY.md` reflects the fallback-secret uniformity.
- [ ] U6 verdict remains recorded in this plan file.

## Verification commands

From repo root:

```sh
bun --filter @slashtalk/electron typecheck
bun --filter @slashtalk/electron test
bun --filter @slashtalk/electron lint
git diff --check
```

No `apps/server` or schema changes in this plan, so no `db:generate` / `gen:db-schema` runs needed.

## Out of scope

- **Stdio bridge-shim refactor.** Deferred until the desktop app spawns the MCP client (the bridge-shim's identity-binding payoff requires a spawn tree). See [`life-wiki/wiki/concepts/mcp-bridge-shim.md`](file:///Users/g/code/life-wiki/wiki/concepts/mcp-bridge-shim.md) for the architectural rationale.
- **Server-side MCP changes.** `apps/server/src/mcp/*` is correct as-is for this scope.
- **Removing legacy-bearer mode entirely.** Separate hardening pass; not blocking this work.
- **Identity binding (`set_active_session` tool, `SLASHTALK_SESSION_ID` env var).** Lands with the notes/todos feature plan, not here.
- **Generating a new proxy secret on every desktop start.** Production path (`localMcpProxySecret.ts`) already persists across restarts; rotating on every start would force re-install on every launch.
- **Multi-machine concerns / OAuth federation.** Server-side; not local-proxy.

## Three questions

### 1. Hardest decision

Whether to persist the bound port or always re-bind from scratch. Two real options:

- **Always re-bind, no persistence.** Simpler, no stored port. Loss: every desktop restart picks a new port, every Claude Code session attached at the time has to reconnect to a different URL — and Claude Code's connection model is to read `~/.claude.json` once at session start, so the in-flight session breaks until Claude is restarted.
- **Persist, with port-zero fallback.** Slightly more code (the U1 helper), one non-secret `store.ts` key. Win: existing client connections come back to the same port on every restart, restart-attached behavior is invisible to the user.

The tiebreaker is that production users _will_ attach Claude Code through this proxy and _will_ restart the desktop app for unrelated reasons (updates, UI bugs, etc.). Persistence is the production-shaped choice.

### 2. Alternatives rejected

- **Always re-bind, no persistence** — see above. Drops live sessions on restart.
- **Sidecar URL file at `~/.config/slashtalk/proxy-url`.** Drifts from the slashtalk per-user state convention (`app.getPath('userData')` via `store.ts` / `safeStore`). Inventing a second location for state is the same anti-pattern `core-beliefs.md` warns about for similar drifts elsewhere.
- **Runtime preflight stdio shim** that pings the desktop and emits a friendly error if it's offline. Rejected: that's the bridge-shim refactor we explicitly deferred. Premature here.
- **Generating a new proxy secret on every start.** Forces re-install on every desktop launch (the secret in `~/.claude.json` becomes stale immediately). Production path is correct as-is; this plan only touches the fallback.
- **Adding a watchdog to start Slashtalk Desktop on demand.** Out of slashtalk's product surface (auto-launch is invasive); also not solvable in the install path because the client triggers the connect, not the desktop.

### 3. Least confident

**Client offline-error wording.** U6's config-surface investigation found no supported static hint field, so the remaining uncertainty is only the exact raw error text Claude Code and Codex show when the local proxy is offline. The implementation should capture that wording in the manual test doc, but should not block U1-U5 on it.

## U6 verdict

Researched 2026-04-29.

- **MCP protocol/spec:** no portable server-install configuration field exists for a host-specific offline hint. Protocol metadata like `description` applies to MCP objects exchanged after connection (`Implementation`, tools, resources, prompts), which does not help when the local proxy process is not running.
- **Claude Code:** public docs and local `@anthropic-ai/claude-agent-sdk` types do not expose a supported `description`/`displayName` field for HTTP server config. Claude Code handles HTTP/SSE reconnects and marks failed servers in `/mcp`, but there is no documented config field for custom offline recovery copy.
- **Codex:** generated config schema rejects unknown MCP server keys (`additionalProperties: false`) and has no `description` or `displayName` field. The legacy `name` key is accepted only as a display-name compatibility field, not as an error hint.
- **Plan outcome:** use docs fallback. Do not write unsupported hint fields into either client config. Add the recovery section to `docs/manual-tests/mcp-local-proxy.md`, and optionally record the observed Claude/Codex error text during manual verification.
