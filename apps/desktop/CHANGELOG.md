# @slashtalk/electron

## 0.1.8

### Patch Changes

- 878ed61: Fix the first-launch experience: signed-out users now see the sign-in window
  on app start (previously only a tray icon was visible), and the rail's
  "+ add repo" bubble reacts live to repo add/remove and to the tray's
  checkbox selection — so it disappears once you add a repo and reappears if
  you uncheck all of them.
- 6445d28: Let the SDK type-check the local-agent default permission mode directly.
- 5ca1b01: Fix the info popover dismissing instantly when opened by clicking an avatar in a project card's Active strip. The popover used the same hover-managed lifecycle for click and hover, so a click that triggered a reposition (the new head's bubble lives elsewhere on the rail than the previous one) immediately fired `mouseleave` and dismissed the card before the user could interact with it.

  Click-opened popovers are now pinned: `info:hoverLeave` is a no-op until the cursor enters the window, at which point the pin "graduates" to the normal hover-managed mode (so hovering off → onto another bubble dismisses naturally). ESC and clicking another of our windows still dismiss while pinned. No new UI affordance.

## 0.1.7

### Patch Changes

- 80e575d: Fix `spawn ENOTDIR` from the Ask window's local agent in the installed `.app` (still failing after the earlier `asarUnpack` fix). The Claude Agent SDK resolves its native `claude` binary via `require.resolve`, which lands at a path inside `app.asar`. Electron auto-translates `fs.*` reads across asar/asar.unpacked, but it does **not** rewrite `child_process.spawn` paths — so the spawn fails because `app.asar` is a regular file, not a directory. Add `apps/desktop/src/main/claudeBin.ts` that computes the unpacked path under `app.asar.unpacked/` (handling both nested and top-level package layouts) and pass it as `pathToClaudeCodeExecutable` to the SDK from both `chatDelegate.ts` and `localAgent.ts`. Returns undefined in dev so the SDK's own resolver runs against on-disk node_modules.

## 0.1.6

### Patch Changes

- 8156a83: Fix `dist:mac` build failure introduced by the previous `asarUnpack` change. With an unpack matcher present, electron-builder's filter runs `getRelativePath` on every file, which threw on workspace-symlinked files like `packages/shared/AGENTS.md` (canonical path lives outside `apps/desktop/`). Move `@slashtalk/shared` from `dependencies` to `devDependencies` in `apps/desktop/package.json` so electron-builder skips it during asar packaging entirely. Safe because the package is purely build-time: Vite bundles it into `out/main/index.js`, the preload only `import type`s it, and the renderer bundles it by default — no runtime `require("@slashtalk/shared")`.

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
