// Cross-app hover polling for the unpinned rail.
//
// When the rail is unpinned and Slashtalk is blurred, the rail sits at normal
// window level and macOS routes mouse events to the frontmost app's windows
// above it. Hover never fires. To preserve hover-to-peek across apps, we poll
// the cursor at 12.5Hz (cheap: one getCursorScreenPoint + rect test) and pop
// the rail to floating level as soon as the cursor enters its bounds. When
// the cursor leaves, we drop back after a short grace so the info popover
// can take over tracking.

import { type BrowserWindow, screen } from "electron";

const HOVER_POLL_INTERVAL_MS = 80;
const HOVER_LEAVE_GRACE_MS = 200;
// Pre-expand the hit rect slightly so we float just before the cursor crosses
// the edge — otherwise the first pixel of entry gets eaten by the transition.
const HOVER_EDGE_MARGIN = 6;

interface HoverPollingDeps {
  getOverlay: () => BrowserWindow | null;
  isRailPinned: () => boolean;
  isAppFocused: () => boolean;
}

let deps: HoverPollingDeps | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let leaveTimer: NodeJS.Timeout | null = null;

export function configureHoverPolling(d: HoverPollingDeps): void {
  deps = d;
}

export function startHoverPolling(): void {
  if (!deps) throw new Error("configureHoverPolling must be called before startHoverPolling");
  if (pollTimer) return;
  pollTimer = setInterval(tick, HOVER_POLL_INTERVAL_MS);
}

export function stopHoverPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

function tick(): void {
  if (!deps) return;
  const overlay = deps.getOverlay();
  if (!overlay || overlay.isDestroyed()) return;
  // Session-only mode hides the rail via overlay.hide(); there's no visible
  // target for hover-to-peek, so skip the cursor math entirely.
  if (!overlay.isVisible()) return;
  // Short-circuit when pinned or focused — the rail is already floating via
  // normal pin/focus paths, so hover "just works" without our help.
  if (deps.isRailPinned() || deps.isAppFocused()) return;
  const cursor = screen.getCursorScreenPoint();
  const b = overlay.getBounds();
  const inside =
    cursor.x >= b.x - HOVER_EDGE_MARGIN &&
    cursor.x <= b.x + b.width + HOVER_EDGE_MARGIN &&
    cursor.y >= b.y - HOVER_EDGE_MARGIN &&
    cursor.y <= b.y + b.height + HOVER_EDGE_MARGIN;
  const isFloating = overlay.isAlwaysOnTop();
  if (inside && !isFloating) {
    overlay.setAlwaysOnTop(true, "floating");
    overlay.moveTop();
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  } else if (!inside && isFloating && !leaveTimer) {
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (!deps) return;
      const o = deps.getOverlay();
      if (!o || o.isDestroyed()) return;
      // Re-check state: don't drop if the user pinned or focused in the grace.
      if (deps.isRailPinned() || deps.isAppFocused()) return;
      o.setAlwaysOnTop(false);
    }, HOVER_LEAVE_GRACE_MS);
  }
}
