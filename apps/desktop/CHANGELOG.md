# @slashtalk/electron

## 0.1.5

### Patch Changes

- 1435cac: Fix `spawn ENOTDIR` when the Ask window's local agent runs in the installed `.app`. The Claude Agent SDK ships its native `claude` binary in platform-specific packages (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, etc.); electron-builder was packing those into `app.asar`, where the OS can't `spawn()` an executable because `app.asar` is a regular file from the kernel's perspective. Add an `asarUnpack` entry for `node_modules/@anthropic-ai/claude-agent-sdk-*/**` so the binaries land in `app.asar.unpacked/` and Electron's spawn handler can route to them. Worked in `bun run dev` because dev mode runs from on-disk node_modules, not asar.

## 0.1.4

### Patch Changes

- f63093b: Surface the real failure reason when the Ask window's local agent run fails. Previously a non-success result from the Claude Agent SDK was collapsed to "Local agent returned an empty answer." in the renderer, hiding spawn/PATH/auth errors that only show up in the installed `.app` (Finder-launched env doesn't inherit the user's shell). The runner now captures the SDK's error message, logs it to the main process, and the IPC handler returns it as `{kind: "error"}` so the renderer renders the actual reason.

## 0.1.3

### Patch Changes

- f77b023: Desktop reliability fixes:
  - Gate Cursor uploads on tracked repos and refresh stale info card state (#260).
  - Harden Electron renderer windows (#263).
  - Cap local MCP proxy request bodies (#261).

## 0.1.2

### Patch Changes

- Fix two desktop reliability issues:
  - Augment `PATH` on macOS so the bundled app can locate a user-installed `gh` CLI (e.g. from Homebrew) when launched from Finder.
  - Serialize the self PR push before the standup fetch so the standup view always reflects the latest pushed state.

## 0.1.1

### Patch Changes

- 030fdd9: Update the packaged desktop default API host to slashtalk.com.

## 0.1.0

### Minor Changes

- 8329e20: Add GitHub-backed desktop auto-update checks with user-prompted install flow.

## 0.0.5

### Patch Changes

- 5677df3: Sign and notarize macOS releases. The `build-mac` job now runs `dist:mac` (signed + notarized) instead of `dist:mac:unsigned`, using the Developer ID Application cert and App Store Connect API key from repo secrets. Users no longer need to right-click → Open or `xattr -cr` to launch the app.

## 0.0.4

### Patch Changes

- 76aaa4c: Disable `installAppDeps` in electron-builder. Bun isn't a drop-in npm replacement here — electron-builder's app-deps step invokes `node /path/to/bun` which fails with `SyntaxError: Invalid or unexpected token` on the Bun binary. Vite already bundles all production code into `out/`, so there's nothing to install.

## 0.0.3

### Patch Changes

- f5bac26: Pin `electronVersion` in the build config so macOS release builds succeed when Bun workspace-hoists `electron` to the repo root.

## 0.0.2

### Patch Changes

- cdabdaf: Initial release test.
