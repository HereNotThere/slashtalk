import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import type { DockConfig, DockOrientation } from "../../shared/types";
import * as store from "../store";
import { debugMacWindowState, setMacCornerRadius } from "../macCorners";
import {
  OVERLAY_WIDTH,
  computeDockBoundsOn,
  dockFromPoint,
  overlayLength,
  screenIdOf,
} from "./dock-geometry";
import { currentDock } from "./dock-drag";
import { getRailPinned } from "./rail-state";
import { resolveRailVisibility } from "./rail-visibility";
import { startHoverPolling, stopHoverPolling } from "./hover-polling";
import { sendWhenLoaded } from "./broadcast";
import { loadRenderer, preloadPath } from "./lib";
import * as info from "./info";
import { hideChat } from "./chat";

const POSITION_KEY = "overlayPosition";
const OVERLAY_SCREEN_MARGIN = 40;

let overlayWindow: BrowserWindow | null = null;
let lastSentDock: DockConfig | null = null;
let desiredOverlayLength: number | null = null;

interface SavedPosition {
  screenId: string;
  xPercent: number;
  topPercent: number;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}

export function appIsFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
}

function restoredOrigin(): { x: number; y: number } | null {
  const pos = store.get<SavedPosition>(POSITION_KEY);
  if (!pos) return null;
  const match =
    screen.getAllDisplays().find((d) => screenIdOf(d) === pos.screenId) ??
    screen.getPrimaryDisplay();
  const f = match.bounds;
  return {
    x: Math.round(f.x + pos.xPercent * f.width),
    y: Math.round(f.y + pos.topPercent * f.height),
  };
}

export function saveOverlayPosition(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const bounds = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const f = display.bounds;
  const payload: SavedPosition = {
    screenId: screenIdOf(display),
    xPercent: (bounds.x - f.x) / f.width,
    topPercent: (bounds.y - f.y) / f.height,
  };
  store.set(POSITION_KEY, payload);
}

// White rim over the `hud` vibrancy. In dark mode the stroke reads as a bright
// hairline, so keep it faint; in light mode the same stroke gets buried by the
// material and needs more alpha to remain visible.
function applyOverlayRim(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setMacCornerRadius(overlayWindow, OVERLAY_WIDTH / 2, {
    width: 1.5,
    white: 1,
    alpha: nativeTheme.shouldUseDarkColors ? 0.12 : 0.33,
  });
}

export function applyRailPinned(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const pinned = getRailPinned();
  console.log(`[pin] applyRailPinned: target=${pinned} focused=${appIsFocused()}`);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Rail floats when pinned always, or when unpinned-and-focused. Otherwise
  // drops to normal so it sits behind frontmost app windows.
  const shouldFloat = pinned || appIsFocused();
  overlayWindow.setAlwaysOnTop(shouldFloat, "floating");
  if (shouldFloat) overlayWindow.moveTop();
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    void app.dock?.show();
  }
  // Cursor polling runs in unpinned mode so the rail pops to floating when
  // the cursor approaches it while Slashtalk is blurred — otherwise hover
  // never fires cross-app.
  if (pinned) stopHoverPolling();
  else startHoverPolling();
  const native = debugMacWindowState(overlayWindow);
  console.log(`[pin] after aot=${overlayWindow.isAlwaysOnTop()} nativeLevel=${native?.level}`);
}

// Renderer-reported length wins when present — it knows about the inactive
// stack's collapsed/expanded state, which main can't infer from heads alone.
// Clamped to the work-area axis so the rail can't outgrow the screen.
//
// Pre-renderer fallback is the 3-wrapper minimum (search + self + create) so
// the window opens at its smallest plausible size and grows once the renderer
// reports the real length. Sizing to `heads.length` instead would briefly
// render the rail at full-expanded width before the renderer collapsed it,
// which read as a wide-to-narrow yoyo on first open.
export function effectiveOverlayLength(
  orientation: DockOrientation,
  display: Electron.Display,
): number {
  const wa = display.workArea;
  const axisExtent = orientation === "vertical" ? wa.height : wa.width;
  const maxLength = Math.max(overlayLength(0), axisExtent - OVERLAY_SCREEN_MARGIN * 2);
  const baseLength = desiredOverlayLength ?? overlayLength(1);
  return Math.min(baseLength, maxLength);
}

export function ensureOverlay(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  const display = screen.getPrimaryDisplay();
  const restored = restoredOrigin();
  // Classify the restored origin against the primary display's work area to
  // pick the initial dock. First-run default: right edge (vertical+end).
  const initialDock: DockConfig = restored
    ? dockFromPoint(restored, display)
    : { orientation: "vertical", side: "end" };
  const bounds = computeDockBoundsOn(
    display,
    initialDock,
    effectiveOverlayLength(initialDock.orientation, display),
  );

  overlayWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: false,
    // Never let the rail become key — macOS deepens the system shadow on
    // focused windows, so without this the drop shadow visibly darkens
    // whenever the user clicks the rail. Clicks still work for drag and
    // bubble toggles.
    focusable: false,
    // System shadow — macOS derives it from the window's alpha mask, so
    // with the rounded contentView + cleared NSWindow background the
    // shadow follows the pill. Re-invalidated in setMacCornerRadius so
    // macOS recomputes against the pill mask instead of the original
    // rectangle.
    hasShadow: true,
    alwaysOnTop: getRailPinned(),
    resizable: false,
    movable: false, // we drive drag manually via IPC + setPosition
    skipTaskbar: true,
    backgroundColor: "#00000000",
    // Start hidden so session-only mode can keep us that way without a flash
    // on first poll. resolveRailVisibility() below decides the initial state.
    show: false,
    // Real macOS frost. CSS backdrop-filter is a no-op on non-vibrancy Electron
    // windows, so the rail uses NSVisualEffectView as its single background.
    // Vibrancy is a sibling NSView of the webContents, so CSS can't clip it —
    // we reshape to a pill via `setMacCornerRadius` below instead.
    // `hud` reads heavily translucent over arbitrary app windows, unlike
    // `under-window` which only blurs the desktop wallpaper.
    vibrancy: "hud",
    visualEffectState: "active",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  applyRailPinned();
  resolveRailVisibility();

  // Pill ends — half the window width gives perfect semicircle caps at top
  // and bottom. Safe to call synchronously: getNativeWindowHandle is valid
  // as soon as the BrowserWindow constructor returns.
  applyOverlayRim();
  nativeTheme.on("updated", applyOverlayRim);

  loadRenderer(overlayWindow, "overlay");

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    lastSentDock = null;
    info.hideNow();
    hideChat();
  });

  // Tell the overlay renderer which dock it was born into so first paint uses
  // the correct flex direction.
  sendOverlayConfig();

  return overlayWindow;
}

export function resizeOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(overlayWindow.getBounds());
  const dock = currentDock();
  const wa = display.workArea;
  const length = effectiveOverlayLength(dock.orientation, display);
  const size =
    dock.orientation === "vertical"
      ? { width: OVERLAY_WIDTH, height: length }
      : { width: length, height: OVERLAY_WIDTH };
  const bounds = overlayWindow.getBounds();
  // Keep the rail inside the work area after a size change so the chat bubble
  // never clips past the edge.
  const axisPos = dock.orientation === "vertical" ? bounds.y : bounds.x;
  const axisMin = (dock.orientation === "vertical" ? wa.y : wa.x) + OVERLAY_SCREEN_MARGIN;
  const axisMax =
    (dock.orientation === "vertical" ? wa.y + wa.height - length : wa.x + wa.width - length) -
    OVERLAY_SCREEN_MARGIN;
  const clamped = Math.max(axisMin, Math.min(axisPos, axisMax));
  const nextBounds =
    dock.orientation === "vertical"
      ? { x: bounds.x, y: clamped, width: size.width, height: size.height }
      : { x: clamped, y: bounds.y, width: size.width, height: size.height };
  // `animate: true` uses macOS's native NSWindow animator (~200ms ease), which
  // reads as a fluid grow/shrink alongside the renderer's bubble enter/exit
  // animations. No-op on other platforms.
  const animate =
    bounds.width !== nextBounds.width ||
    bounds.height !== nextBounds.height ||
    bounds.x !== nextBounds.x ||
    bounds.y !== nextBounds.y;
  overlayWindow.setBounds(nextBounds, animate);
}

// Tell the overlay renderer which dock it's in so it can pick flex direction,
// scroll axis, and FLIP-tracking axis. Only sent on change to avoid redundant
// layout passes.
export function sendOverlayConfig(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const dock = currentDock();
  if (
    lastSentDock &&
    lastSentDock.orientation === dock.orientation &&
    lastSentDock.side === dock.side
  ) {
    return;
  }
  lastSentDock = dock;
  sendWhenLoaded(overlayWindow, "overlay:config", dock);
}

// Called from rail.onChange when the rail empties out — closes the window so
// the session-only state machine doesn't keep an empty pill on screen.
export function closeOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.close();
  overlayWindow = null;
}

// Unpinned mode: rail follows app focus. Float when active so hover works,
// drop to normal when blurred so it sits behind other apps.
export function onAppDidBecomeActive(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (getRailPinned()) return;
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.moveTop();
}

export function onAppDidResignActive(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (getRailPinned()) return;
  overlayWindow.setAlwaysOnTop(false);
}

export function registerOverlay(): void {
  ipcMain.handle("overlay:setLength", (_e, length: number): void => {
    if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) return;
    const next = Math.round(length);
    if (next === desiredOverlayLength) return;
    desiredOverlayLength = next;
    resizeOverlay();
  });
}
