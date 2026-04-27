// Session-only rail visibility.
//
// When session-only mode is on and the rail is not pinned, the rail hides
// until the signed-in user has an active session (or they force-open via
// the tray). A single 15-minute grace timer keeps the rail visible briefly
// after the last session ends so short breaks don't thrash show/hide.

import type { BrowserWindow } from "electron";

const SESSION_GRACE_MS = 15 * 60 * 1000;

interface RailVisibilityDeps {
  getOverlay: () => BrowserWindow | null;
  isRailPinned: () => boolean;
  isSessionOnlyMode: () => boolean;
  isSelfLive: () => boolean;
}

let deps: RailVisibilityDeps | null = null;
let graceTimer: NodeJS.Timeout | null = null;
let lastActivityTs = 0;

export function configureRailVisibility(d: RailVisibilityDeps): void {
  deps = d;
}

/** Bump the activity timestamp to "now". Called when a self session ticks
 *  live, or when the user force-opens via the tray. Inert outside
 *  session-only mode — resolveRailVisibility ignores it while pinned. */
export function bumpActivity(): void {
  lastActivityTs = Date.now();
}

export function resolveRailVisibility(): void {
  if (!deps) return;
  const overlay = deps.getOverlay();
  if (!overlay || overlay.isDestroyed()) return;

  const pinned = deps.isRailPinned();
  const sessionOnly = deps.isSessionOnlyMode();
  const selfLive = deps.isSelfLive();

  let visible: boolean;
  if (pinned || !sessionOnly || selfLive) {
    visible = true;
  } else {
    visible = Date.now() - lastActivityTs < SESSION_GRACE_MS;
  }

  if (visible && !overlay.isVisible()) overlay.show();
  else if (!visible && overlay.isVisible()) overlay.hide();

  // Arm the grace timer only while we're inside the session-only grace
  // window (visible, but with no live self session). Any other state
  // cancels it — including pinned (rail always shown) and !sessionOnly.
  const inGraceWindow = visible && sessionOnly && !pinned && !selfLive;
  if (inGraceWindow) scheduleGraceHide();
  else cancelGraceTimer();
}

function scheduleGraceHide(): void {
  cancelGraceTimer();
  const remaining = Math.max(0, SESSION_GRACE_MS - (Date.now() - lastActivityTs));
  graceTimer = setTimeout(() => {
    graceTimer = null;
    resolveRailVisibility();
  }, remaining);
}

function cancelGraceTimer(): void {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}
