# Rail pinning (pin / unpin)

User-facing toggle in the tray popup: **"Keep rail on top"**. Controls whether the overlay rail floats above every other app always, or only while Slashtalk is focused.

This doc exists because getting "on top only when focused" right on macOS took several attempts — several of the obvious fixes are traps. If you're about to change any of this, read all of it first.

## Behavior

| Pin state        | Slashtalk focused | Slashtalk blurred                       | Cursor over rail                                     |
| ---------------- | ----------------- | --------------------------------------- | ---------------------------------------------------- |
| Pinned (default) | floats            | floats                                  | hover works                                          |
| Unpinned         | floats            | normal z-order → sits behind other apps | rail briefly floats so hover-to-peek works cross-app |

Persisted as `railPinned` in `store` (default `true`).

## Code

All in `src/main/index.ts`:

- `getRailPinned()` / `applyRailPinned()` — read persisted pref, apply to the overlay window
- `rail:getPinned` / `rail:setPinned` IPC + `rail:pinned` broadcast (preload exposes `window.chatheads.rail`)
- `app.on("did-become-active" | "did-resign-active")` — flip the rail's always-on-top along with app focus when unpinned
- `startHoverPolling()` / `hoverPollTick()` — cursor polling that raises the rail to floating when the cursor approaches it while the app is blurred (cross-app hover)
- `debugMacWindowState()` in `src/main/macCorners.ts` — reads the native `[NSWindow level]` + `collectionBehavior` via koffi; useful when Electron's `isAlwaysOnTop()` disagrees with what you see on screen

Renderer UI: the "Keep rail on top" checkbox in `src/renderer/statusbar/App.tsx`.

## macOS gotchas (all of them actually bit us)

The overlay is `focusable: false`, which Electron implements as an `NSPanel` with the non-activating style mask. This is load-bearing — making it `focusable: true` darkens the system shadow whenever the rail is clicked, because macOS deepens shadows on key windows. But it creates a cascade of peculiarities:

1. **App drops out of Cmd+Tab when the only visible window is a normal-level NSPanel.** The rail alone doesn't count as a "real" window for app switcher purposes. The main config window (`createMainWindow`) must stay **hidden-on-close** (not destroyed) so there's always a regular `NSWindow` propping up the app's presence. See the `close` handler that `preventDefault()`s when `!app.isQuitting`.

2. **macOS demotes the app to `accessory` activation policy** when it slips into the "only an NSPanel is visible, and it's at normal level" state. We defend against this by calling `app.setActivationPolicy("regular") + app.dock.show()` at three points: boot, every `applyRailPinned()` call, and every `did-resign-active`. Without the blur-time re-assertion, the dock icon vanishes every time the user cmd-tabs away while unpinned.

3. **`setAlwaysOnTop(false, "floating")` leaves the window at the "floating" level.** Electron's second argument applies even when the first is false. Always call `setAlwaysOnTop(false)` without a level arg when dropping.

4. **`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` is required for cross-space behavior.** The `fullScreenAuxiliary` collection behavior also happens to let a non-focusable window receive mouseMoved events while another app is frontmost. Keep it on in both pin states — dropping it breaks hover even when the rail looks visible.

5. **Non-activating NSPanels don't ride normal app z-order on activation.** When Slashtalk becomes frontmost after being blurred, other apps' windows can stay above the rail because non-activating panels aren't included in the "bring app windows forward" operation. The `did-become-active` handler explicitly calls `setAlwaysOnTop(true, "floating") + moveTop()` to force it up.

6. **Cross-app hover requires floating-level hit-testing.** A window at normal level behind another app's windows receives no mouse events — period. There's no NSWindow flag that overrides this; that's what the floating level exists for. The only way to get cross-app hover on an unpinned rail is to _temporarily_ raise to floating when the cursor approaches. That's what `hoverPollTick()` does (12.5Hz cursor sampling, ~6px edge margin, 200ms leave grace).

## Things that don't work — don't retry

- **Toggling only `setAlwaysOnTop`.** The rail "looks" on top because its screen position is at an uncovered edge, but the collection behavior from `setVisibleOnAllWorkspaces` keeps its NSPanel at floating level under the hood. On top of that, the dock drops as described above.
- **Hiding the rail on blur, showing on focus.** Clean in theory, but with the main window hidden too the app has zero visible windows → dock icon and Cmd+Tab entry vanish. Re-asserting `setActivationPolicy("regular")` _can_ recover but the transition feels broken, and pinning back up doesn't always restore dock presence.
- **Making the rail `focusable: true` in unpinned mode.** Solves the Cmd+Tab "app has nothing to focus" problem, but the system shadow darkens every time the rail is clicked — immediately obvious on the frosted pill, looks broken.
- **Dropping `setVisibleOnAllWorkspaces` when unpinned.** Breaks cross-app mouse events entirely. Hover dies even when the rail is the topmost window at the cursor position.

## The polling loop (cross-app hover)

Runs only while unpinned. Each tick (~80ms):

1. Early return if pinned or Slashtalk is focused (both states already float).
2. Read `screen.getCursorScreenPoint()` + `overlayWindow.getBounds()`.
3. Cursor inside the rail's rect (+6px edge margin) → `setAlwaysOnTop(true, "floating") + moveTop()`.
4. Cursor outside and rail is currently floating → 200ms grace timer, then `setAlwaysOnTop(false)`.

The ~80ms first-entry latency is the trade for not running an NSView-level tracking area via koffi. The leave grace covers the transition onto the info popover so the popover's own hover handlers can take over without the rail visibly flickering.

Cost: one `getCursorScreenPoint` + rect compare per tick, short-circuited when pinned or focused. Negligible.

## When updating this

If you touch the rail's window flags (`focusable`, `vibrancy`, `alwaysOnTop`, `visibleOnAllWorkspaces`, the activation policy re-assertions, or the hover polling cadence), update this doc in the same change — the gotchas are the whole point of the file.
