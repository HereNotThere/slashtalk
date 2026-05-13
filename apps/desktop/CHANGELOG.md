# @slashtalk/electron

## 0.4.1

### Patch Changes

- d023097: Update the feedback link in the project info popover to point to help@towns.com (and surface it as the visible text), and add the same link to the onboarding steps so new users have a clear way to ask for help.

## 0.4.0

### Minor Changes

- 124723a: Ship Apple Silicon (arm64) builds only. The universal target embedded both x64 and arm64 slices of the Electron framework into every download (~415MB raw); dropping x64 halves that, and Apple has not shipped Intel Macs since mid-2023. Intel Mac users on the existing universal build won't auto-update (electron-updater filters `latest-mac.yml` by `process.arch` and there'll be no x64 entry); they can keep using their installed version.
- c3edcb3: Use the user's installed `claude` CLI instead of bundling the ~200MB platform-specific binary. The packaged DMG drops from ~250MB to ~190MB; on-disk app from ~677MB to ~487MB. Slashtalk now expects Claude Code to already be installed on the user's machine and resolves it via `command -v claude` in a login shell (picks up nvm/Volta/Bun/Homebrew PATH mutations that GUI-launched Electron doesn't inherit on macOS), falling back to common install locations (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.volta/bin`). When no `claude` is found, the chat surfaces a clear "install Claude Code" message instead of a cryptic spawn failure.

### Patch Changes

- 6fb10bc: drop bundled claude binary, use system install

## 0.3.0

### Minor Changes

- 87229c3: Add Pi session-folder support so Slashtalk can ingest and show local Pi coding sessions alongside Claude Code, Codex, and Cursor sessions, with Pi extension-state entries and large signature/image payloads scrubbed before upload.

### Patch Changes

- a4aaf4c: Tighten the gap above markdown blocks (e.g. PAST 24H summary in the hierarchy dashboard) by stripping the leading/trailing margin on the first and last children. The first paragraph's `my-2` was stacking on top of the container's padding, making the section look visibly looser than the adjacent "Now" block.
- f45293f: Hide the info window's "Now" section for sessions that don't yet have an analyzer-generated description.

  Brand-new sessions (under three events) haven't run the summary analyzer, so their description is `null` and the "Now" card was rendering a placeholder ("Summarizing…") that read as broken. The picker now skips description-less sessions in both the live and recent-fallback branches; if nothing qualifies, the section hides and the past-day standup takes its place until Haiku catches up.

- f3359dc: Stop the info window's "Now" section from sticking on a stale BUSY/ACTIVE session.

  The desktop's per-head session cache held rows indefinitely until a `session_updated` WebSocket message invalidated them, but those messages are only emitted when the server's classification changes — so a stuck `inTurn=true` (or a single dropped packet during the BUSY → IDLE transition) left the cache serving "working now…" forever. Cache entries now expire after 10 seconds, so the renderer's 15s polling tick always refetches; rapid re-hovers within the window still hit cache for snappy paint.

- 1f185bc: The PR list on your own user-card now respects the `user_repos` claim gate, matching the standup blurb rendered next to it. Previously the list came straight from `gh api graphql` (no repo filter) and showed PRs from any repo you'd authored on GitHub in the past 24h, even ones you hadn't claimed in slashtalk — visibly inconsistent with the standup, which only ever mentioned claimed-repo PRs. The desktop now uses `gh` only as the writer (push fresh PRs into the server's `pull_requests` table, which already gates upserts on `user_repos`), and reads the displayed list from the same server endpoint the peer path uses (`/api/users/:login/prs`).
- 0814fcd: Force WS-triggered session refreshes to bypass the 15s-poll in-flight. Without
  this, a `session_updated` or `collision_detected` event landing while the
  renderer's poll fetch is mid-flight would join that in-flight, resolve with
  pre-event data, and repopulate the cache stale — defeating the invalidation.
  Most visible failure mode: collision rings silently not painting on a real
  collision when the verify call raced a poll fetch. Now `fetchSessionsForHead`
  takes `{ force?: boolean }` mirroring `fetchProjectOverviewForRepo`, threaded
  through `refreshNow` and the collision verifier.

## 0.2.1

### Patch Changes

- 0e83d9e: Fix the "Now" section getting stuck on "Summarizing…" indefinitely. A transient analyzer error was clearing the previously-computed description from the snapshot even though the prior good output was preserved in the database. Surface the preserved output across errors, and hide the description line entirely when no summary exists rather than showing a misleading active-state placeholder.

## 0.2.0

### Minor Changes

- 6b9804b: Inactive teammates (idle >24h) are now hidden from the rail by default and surface as a hover-expanding stack only when the new "Show inactive teammates" tray toggle is on. Replaces the previous "Stack inactive teammates" toggle — stacking is now the only display mode for inactive peers.

### Patch Changes

- 68af310: "Add local repo" now gives a precise reason when it fails: distinguishes a folder that isn't a git repo (and lists git child folders if the picked dir is a parent of repos), a repo with no remotes, a repo with a non-GitHub remote, and a repo already tracked (with the path it's tracked at). Linked git worktrees now resolve transparently to the main repo. The `no_access` claim error is rewritten to name the specific owner and to acknowledge both the org-OAuth-restriction and the collaborator-only-on-someone-else's-personal-repo cases. The error in the tray popup now renders as a dismissible warning box headed with "Couldn't add `<path>`" (the path is middle-truncated to fit) above the human reason, instead of small inline text. The tray popup re-focuses itself after the folder picker closes (so any error stays visible without re-clicking the tray), and the underlying message no longer leaks the IPC channel prefix ("Error invoking remote method 'backend:addLocalRepo': Error: …").
- 4ee25d3: When "Add local repo" fails because the repo's owning org hasn't authorized slashtalk's GitHub OAuth app, the error now shows a "Grant access on GitHub →" button that opens slashtalk's authorized-OAuth-apps page on github.com. From there a single click on "Grant" next to the org unblocks the claim. Previously the error explained the cause but left the user to find the page themselves. The server now also busts its 60-second org-membership cache after a `no_access` outcome and refetches once before giving up — without this, the user would keep seeing the same error for up to a minute after granting access on GitHub.
- 878ed61: Fix the first-launch experience: signed-out users now see the sign-in window
  on app start (previously only a tray icon was visible), and the rail's
  "+ add repo" bubble reacts live to repo add/remove and to the tray's
  checkbox selection — so it disappears once you add a repo and reappears if
  you uncheck all of them.
- 720f15b: Fix two info-card glitches: the shimmer no longer flashes on every cached refetch, and it no longer fires when hovering between teammate or project cards. The transition only runs when the same card's payload actually changes — old content is held under shimmer for ~1s, then swaps to the new render.
- 6445d28: Let the SDK type-check the local-agent default permission mode directly.
- 5ca1b01: Fix the info popover dismissing instantly when opened by clicking an avatar in a project card's Active strip. The popover used the same hover-managed lifecycle for click and hover, so a click that triggered a reposition (the new head's bubble lives elsewhere on the rail than the previous one) immediately fired `mouseleave` and dismissed the card before the user could interact with it.

  Click-opened popovers are now pinned: `info:hoverLeave` is a no-op until the cursor enters the window, at which point the pin "graduates" to the normal hover-managed mode (so hovering off → onto another bubble dismisses naturally). ESC and clicking another of our windows still dismiss while pinned. No new UI affordance.

- 99dc14e: Fix the repo label on info-dashboard "Now" cards. Previously the fallback split a dash-slugified project path on `/` and `-`, so a repo named `test-repo` rendered as `repo`. Two changes: peer sessions (with a matched `repo_full_name`) now render that name; while the match is still loading they render nothing instead of flashing a misleading cwd segment like "desktop". Own sessions fall back to the cwd basename, which preserves dashes inside repo names.

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
