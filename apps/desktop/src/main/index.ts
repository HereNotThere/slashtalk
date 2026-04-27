import {
  app,
  BrowserWindow,
  nativeTheme,
  ipcMain,
  screen,
  clipboard,
  shell,
  dialog,
  globalShortcut,
} from "electron";
import type {
  AgentHistoryPage,
  AgentSessionSummary,
  AgentStreamEvent,
  AgentSummary,
  ChatHead,
  CreateAgentInput,
  DockConfig,
  DockOrientation,
  InfoSession,
  McpTarget,
  ResponseOpenPayload,
  UpdateAgentInput,
} from "../shared/types";
import * as store from "./store";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as rail from "./rail";
import * as uploader from "./uploader";
import * as heartbeat from "./heartbeat";
import * as ws from "./ws";
import * as installMcp from "./installMcp";
import * as chatheadsAuth from "./chatheadsAuth";
import * as selfSession from "./selfSession";
import { createLocalMcpProxy } from "./localMcpProxy";
import { getLocalMcpProxySecret } from "./localMcpProxySecret";
import * as anthropic from "./anthropic";
import * as localAgent from "./localAgent";
import * as agentStore from "./agentStore";
import * as agentIngest from "./agentIngest";
import * as summarize from "./summarize";
import * as githubAuth from "./githubDeviceAuth";
import type { LocalAgent } from "./agentStore";
import * as spotify from "./spotify";
import * as peerPresence from "./peerPresence";
import { setMacCornerRadius, debugMacWindowState } from "./macCorners";
import {
  BUBBLE_PAD,
  BUBBLE_SIZE,
  OVERLAY_WIDTH,
  PADDING_Y,
  computeDockBoundsOn,
  dockFromPoint,
  overlayLength,
  overlaySize,
  screenIdOf,
} from "./windows/dock-geometry";
import {
  broadcastRailCollapseInactive,
  broadcastRailPinned,
  broadcastRailSessionOnlyMode,
  broadcastShowActivityTimestamps,
  configureRailState,
  getRailCollapseInactive,
  getRailPinned,
  getRailSessionOnlyMode,
  getShowActivityTimestamps,
  getSpotifyShareEnabled,
  setRailCollapseInactive,
  setRailPinned,
  setRailSessionOnlyMode,
  setShowActivityTimestamps,
  setSpotifyShareEnabled,
} from "./windows/rail-state";
import {
  configureChat,
  hideChat,
  isChatVisible,
  repositionChatIfVisible,
  toggleChat,
} from "./windows/chat";
import {
  configureHoverPolling,
  startHoverPolling,
  stopHoverPolling,
} from "./windows/hover-polling";
import { animateOverlayTo, cancelOverlayAnimation } from "./windows/overlay-animation";
import { appState, loadRenderer, preloadPath } from "./windows/lib";
import {
  bumpActivity,
  configureRailVisibility,
  resolveRailVisibility,
} from "./windows/rail-visibility";
import { getMainWindow, showMainWindow } from "./windows/main";
import { configureResponse, getResponseWindow, showResponse } from "./windows/response";
import { createTray, getTrayPopup, hideTrayPopup, toggleTrayPopup } from "./windows/tray";

installMcp.configureInstaller({
  localProxySecret: getLocalMcpProxySecret,
});

const mcpProxy = createLocalMcpProxy({
  getToken: backend.getApiKey,
  getProxySecret: getLocalMcpProxySecret,
  remoteMcpUrl: installMcp.remoteMcpUrl,
});

const INFO_WIDTH = 340;
const INFO_INITIAL_HEIGHT = 80; // small placeholder; renderer reports actual on mount
const INFO_GAP = 8; // distance from the pill's outer edge to the info window
// Match Tailwind `rounded-3xl` (1.5rem) — the renderer used to apply the same
// radius in CSS, but vibrancy is a sibling NSView so only native clipping
// catches the popover material at the corners. Gated to macOS 15+ inside
// setMacCornerRadius; older versions fall back to a plain rectangle.
const INFO_RADIUS = 24;

const RESIZE_MIN = 60;
const RESIZE_MAX = 900;
// Info window caps at whichever is smaller: a hard ceiling, or 2/3 of the
// screen's work area. Computed per-resize so a display change just works.
const INFO_MAX_ABSOLUTE = 650;
const INFO_MAX_SCREEN_FRACTION = 2 / 3;

// Tracked dynamically — renderer reports its content height via IPC and we
// resize/reposition the window each time it changes.
let infoCurrentHeight = INFO_INITIAL_HEIGHT;

// Last observed rendered height per head, keyed by head id. Populated from
// renderer resize reports. Lets subsequent shows of the same head size the
// window correctly on first paint instead of resizing after render.
const infoHeightByHead = new Map<string, number>();

// Delay between the user leaving a rail bubble and the info window actually
// hiding. Gives them time to move the cursor onto the info panel, which cancels
// the pending hide via infoHoverEnter.
const INFO_HIDE_GRACE_MS = 180;

// Matches the renderer's CSS fade-out duration. After the opacity transition,
// the NSWindow is hidden so it doesn't intercept events while invisible.
const INFO_FADE_OUT_MS = 90;

// Pending "user left the rail" hide. Cancelled if the cursor enters the info
// panel or re-enters a bubble within INFO_HIDE_GRACE_MS.
let infoHideGraceTimer: NodeJS.Timeout | null = null;

// Pending `win.hide()` after the renderer has faded out. Cancelled if we
// re-show before the fade completes.
let infoHideFadeTimer: NodeJS.Timeout | null = null;

const POSITION_KEY = "overlayPosition";

function updateSpotifyRunning(): void {
  const shouldRun =
    backend.getAuthState().signedIn && getSpotifyShareEnabled() && process.platform === "darwin";
  if (shouldRun) void spotify.start();
  else spotify.stop();
}

function applyRailPinned(): void {
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

function appIsFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
}

let overlayWindow: BrowserWindow | null = null;
let infoWindow: BrowserWindow | null = null;

let heads: ChatHead[] = [];
let selectedHeadId: string | null = null;
const sessionCache = new Map<string, InfoSession[]>();

function toAgentSummary(a: LocalAgent): AgentSummary {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    systemPrompt: a.systemPrompt,
    model: a.model,
    createdAt: a.createdAt,
    mode: a.mode ?? "cloud",
    cwd: a.cwd,
    visibility: a.visibility ?? "private",
    mcpServers: a.mcpServers,
  };
}

function isLocalAgent(a: { mode?: "cloud" | "local" }): boolean {
  return a.mode === "local";
}

const streamingAgents = new Set<string>();

function findHead(id: string): ChatHead | undefined {
  return heads.find((h) => h.id === id);
}

let dragOffset: { dx: number; dy: number } | null = null;
let dragTicker: ReturnType<typeof setInterval> | null = null;
// While the stack is being dragged, bubble hovers still fire (the cursor sits
// over bubbles as the window moves under it), which would pop the info card
// repeatedly. Suppress showInfo for the duration of the drag + dock animation.
let isDraggingStack = false;

// Dock-to-edge feature. During drag we show a dashed ghost at the nearest dock
// slot (center-left / center-right); on release the overlay tweens to it.
const DOCK_ANIM_MS = 180;
let dockPlaceholderWindow: BrowserWindow | null = null;

// -------- Overlay (bubbles) --------

// Persisted overlay origin — the screen and the relative position within it.
// Restored on launch so the rail comes back where the user left it.
interface SavedPosition {
  screenId: string;
  xPercent: number;
  topPercent: number;
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

function saveOverlayPosition(): void {
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

function ensureOverlay(): BrowserWindow {
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
    hideInfoNow();
    hideChat();
  });

  // Tell the overlay renderer which dock it was born into so first paint uses
  // the correct flex direction.
  sendOverlayConfig();

  return overlayWindow;
}

const OVERLAY_SCREEN_MARGIN = 40;

let desiredOverlayLength: number | null = null;

// Renderer-reported length wins when present — it knows about the inactive
// stack's collapsed/expanded state, which main can't infer from heads alone.
// Clamped to the work-area axis so the rail can't outgrow the screen.
//
// Pre-renderer fallback is the 3-wrapper minimum (search + self + create) so
// the window opens at its smallest plausible size and grows once the renderer
// reports the real length. Sizing to `heads.length` instead would briefly
// render the rail at full-expanded width before the renderer collapsed it,
// which read as a wide-to-narrow yoyo on first open.
function effectiveOverlayLength(orientation: DockOrientation, display: Electron.Display): number {
  const wa = display.workArea;
  const axisExtent = orientation === "vertical" ? wa.height : wa.width;
  const maxLength = Math.max(overlayLength(0), axisExtent - OVERLAY_SCREEN_MARGIN * 2);
  const baseLength = desiredOverlayLength ?? overlayLength(1);
  return Math.min(baseLength, maxLength);
}

function resizeOverlay(): void {
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

function broadcastHeads(): void {
  const targets = [overlayWindow, getMainWindow(), getTrayPopup(), infoWindow].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  );
  for (const w of targets) w.webContents.send("heads:update", heads);
}

// -------- Info box --------

function ensureInfoWindow(): BrowserWindow {
  if (infoWindow && !infoWindow.isDestroyed()) return infoWindow;

  infoWindow = new BrowserWindow({
    width: INFO_WIDTH,
    height: INFO_INITIAL_HEIGHT,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    vibrancy: "popover",
    visualEffectState: "active",
    hasShadow: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  infoWindow.setAlwaysOnTop(true, "floating");
  infoWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  setMacCornerRadius(infoWindow, INFO_RADIUS);

  loadRenderer(infoWindow, "info");

  // No blur-hide: hover model owns visibility; a blur-triggered hide fights
  // with the leave-timer and click-outside logic.
  infoWindow.on("closed", () => {
    infoWindow = null;
  });

  return infoWindow;
}

function positionInfo(headId: string, bubbleScreen?: { x: number; y: number }): void {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const stackBounds = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(stackBounds);
  const screenFrame = display.workArea;
  const dock = currentDock();

  // Fallback coord when the renderer didn't report a bubble rect (e.g.
  // repositions during drag/slide). Derived from the head's position on the
  // rail. Each wrapper is `cell` long; the bubble inside sits BUBBLE_PAD past
  // the wrapper top.
  const cell = BUBBLE_SIZE + BUBBLE_PAD * 2;
  const idx = heads.findIndex((h) => h.id === headId);
  const fallbackAxisOffset = PADDING_Y + BUBBLE_PAD + Math.max(0, idx) * cell;

  if (dock.orientation === "vertical") {
    const infoX =
      dock.side === "start"
        ? stackBounds.x + stackBounds.width + INFO_GAP
        : stackBounds.x - INFO_GAP - INFO_WIDTH;
    const avatarTopY = bubbleScreen?.y ?? stackBounds.y + fallbackAxisOffset;
    const desiredY = Math.round(avatarTopY - 16);
    const bottomLimit = screenFrame.y + screenFrame.height - 32;
    const maxY = bottomLimit - infoCurrentHeight;
    const infoY = Math.max(screenFrame.y + 8, Math.min(desiredY, maxY));
    infoWindow.setBounds({
      x: Math.round(infoX),
      y: infoY,
      width: INFO_WIDTH,
      height: infoCurrentHeight,
    });
    return;
  }

  // Horizontal: info sits below (top-docked) or above (bottom-docked) the
  // rail. Anchor X to the bubble's screen-X when available.
  const infoY =
    dock.side === "start"
      ? stackBounds.y + stackBounds.height + INFO_GAP
      : stackBounds.y - INFO_GAP - infoCurrentHeight;
  const avatarLeftX = bubbleScreen?.x ?? stackBounds.x + fallbackAxisOffset;
  const desiredX = Math.round(avatarLeftX - 16);
  const rightLimit = screenFrame.x + screenFrame.width - 8;
  const maxX = rightLimit - INFO_WIDTH;
  const infoX = Math.max(screenFrame.x + 8, Math.min(desiredX, maxX));
  infoWindow.setBounds({
    x: infoX,
    y: Math.round(infoY),
    width: INFO_WIDTH,
    height: infoCurrentHeight,
  });
}

async function showInfo(
  headId: string,
  bubbleScreen?: { x: number; y: number },
  expandSessionId?: string,
): Promise<void> {
  if (isDraggingStack) return;
  const head = findHead(headId);
  if (!head) return;

  // Cancel any pending hide so fast re-entry just swaps content.
  if (infoHideGraceTimer) {
    clearTimeout(infoHideGraceTimer);
    infoHideGraceTimer = null;
  }
  if (infoHideFadeTimer) {
    clearTimeout(infoHideFadeTimer);
    infoHideFadeTimer = null;
  }

  const win = ensureInfoWindow();
  selectedHeadId = head.id;

  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      win.webContents.once("did-finish-load", () => resolve());
    });
    // A newer show/hide may have fired while we awaited load.
    if (selectedHeadId !== head.id) return;
    if (win.isDestroyed()) return;
  }

  // Size the window using the cached height for this head (if we've rendered
  // it before) so first paint lands at the right size instead of mid-resize.
  const cachedHeight = infoHeightByHead.get(head.id);
  if (cachedHeight) infoCurrentHeight = cachedHeight;

  // Send cached sessions + current Spotify presence immediately; renderer
  // handles the `null` cases by loading on its own effect.
  const cached = sessionCache.get(head.id) ?? null;
  const login = rail.parseUserHeadId(head.id);
  const spotifyPresence = login ? peerPresence.get(login) : null;
  win.webContents.send("info:show", {
    head,
    sessions: cached,
    expandSessionId: expandSessionId ?? null,
    spotify: spotifyPresence,
  });

  // Animate position/size when switching heads on an already-visible window;
  // land-in-place on first appearance.
  const firstShow = !win.isVisible();
  positionInfo(head.id, bubbleScreen);
  if (firstShow) win.showInactive();
  broadcastInfoState(true, head.id);

  // Cache miss: fetch in the background and push the result to the renderer.
  // The renderer's load-effect is keyed on head.id, so a re-hover of the same
  // head after the cache was cleared (e.g. by uploader.onIngested) won't
  // re-fire it — without this push the renderer sits on "Loading…" (and any
  // expanded row is hidden) until the 15s poll ticks.
  if (!cached) {
    void fetchSessionsForHead(head.id).then((loaded) => {
      if (selectedHeadId !== head.id) return;
      if (!infoWindow || infoWindow.isDestroyed()) return;
      const refreshedLogin = rail.parseUserHeadId(head.id);
      infoWindow.webContents.send("info:show", {
        head,
        sessions: loaded,
        expandSessionId: expandSessionId ?? null,
        spotify: refreshedLogin ? peerPresence.get(refreshedLogin) : null,
      });
    });
  }
}

function scheduleHideInfo(): void {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  if (infoHideGraceTimer) clearTimeout(infoHideGraceTimer);
  infoHideGraceTimer = setTimeout(() => {
    infoHideGraceTimer = null;
    hideInfoNow();
  }, INFO_HIDE_GRACE_MS);
}

function cancelHideInfo(): void {
  if (infoHideGraceTimer) {
    clearTimeout(infoHideGraceTimer);
    infoHideGraceTimer = null;
  }
  if (infoHideFadeTimer) {
    clearTimeout(infoHideFadeTimer);
    infoHideFadeTimer = null;
  }
}

function hideInfoNow(): void {
  selectedHeadId = null;
  broadcastInfoState(false, null);
  if (infoWindow && !infoWindow.isDestroyed()) {
    infoWindow.webContents.send("info:hide");
    // Defer the actual NSWindow hide until the renderer's fade-out completes
    // so we don't clip the transition.
    if (infoHideFadeTimer) clearTimeout(infoHideFadeTimer);
    infoHideFadeTimer = setTimeout(() => {
      infoHideFadeTimer = null;
      if (infoWindow && !infoWindow.isDestroyed() && selectedHeadId === null) {
        infoWindow.hide();
      }
    }, INFO_FADE_OUT_MS);
  }
}

function repositionInfoIfVisible(): void {
  if (!selectedHeadId) return;
  if (!findHead(selectedHeadId)) return;
  positionInfo(selectedHeadId);
}

// -------- Overlay-renderer notifications --------

let lastSentDock: DockConfig | null = null;

function broadcastChatVisible(visible: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send("chat:state", { visible });
}

function broadcastInfoState(visible: boolean, headId: string | null): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send("info:state", { visible, headId });
}

// Tell the overlay renderer which dock it's in so it can pick flex direction,
// scroll axis, and FLIP-tracking axis. Only sent on change to avoid redundant
// layout passes.
function sendOverlayConfig(): void {
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
  const send = (): void => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send("overlay:config", dock);
  };
  if (overlayWindow.webContents.isLoading()) {
    overlayWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

// -------- IPC --------

ipcMain.handle("heads:list", (): ChatHead[] => heads);

ipcMain.handle("rail:getPinned", (): boolean => {
  const v = getRailPinned();
  console.log(`[pin] ipc getPinned → ${v}`);
  return v;
});
ipcMain.handle("rail:setPinned", (_e, pinned: boolean): void => {
  console.log(`[pin] ipc setPinned(${pinned})`);
  setRailPinned(pinned);
  applyRailPinned();
  resolveRailVisibility();
  broadcastRailPinned();
});

ipcMain.handle("rail:getSessionOnlyMode", (): boolean => getRailSessionOnlyMode());
ipcMain.handle("rail:setSessionOnlyMode", (_e, enabled: boolean): void => {
  setRailSessionOnlyMode(enabled);
  resolveRailVisibility();
  broadcastRailSessionOnlyMode();
});

ipcMain.handle("rail:getCollapseInactive", (): boolean => getRailCollapseInactive());
ipcMain.handle("rail:setCollapseInactive", (_e, enabled: boolean): void => {
  setRailCollapseInactive(enabled);
  broadcastRailCollapseInactive();
});

ipcMain.handle("rail:getShowActivityTimestamps", (): boolean => getShowActivityTimestamps());
ipcMain.handle("rail:setShowActivityTimestamps", (_e, shown: boolean): void => {
  setShowActivityTimestamps(shown);
  broadcastShowActivityTimestamps();
});

ipcMain.handle("spotify:isSupported", (): boolean => process.platform === "darwin");
ipcMain.handle("spotify:getShareEnabled", (): boolean => getSpotifyShareEnabled());
ipcMain.handle("spotify:setShareEnabled", async (_e, enabled: boolean): Promise<void> => {
  const next = !!enabled;
  const prev = getSpotifyShareEnabled();
  if (prev === next) return;
  setSpotifyShareEnabled(next);
  broadcastToTrayAndMain("spotify:shareEnabled", next);
  // Turning off while signed in: clear peers immediately so the card
  // disappears in seconds instead of waiting for the 120s Redis TTL.
  if (prev && !next && backend.getAuthState().signedIn) {
    try {
      await backend.postSpotifyPresence(null);
    } catch (err) {
      console.warn("[spotify] clear on disable failed", err);
    }
  }
  updateSpotifyRunning();
});

ipcMain.handle("debug:railSnapshot", () => rail.getDebugSnapshot());
ipcMain.handle("debug:refreshRail", () => rail.forceRefresh());
ipcMain.handle("debug:shuffleRail", () => rail.debugShuffleRail());
ipcMain.handle("debug:addFakeTeammate", () => rail.debugAddFakeTeammate());
ipcMain.handle("debug:removeFakeTeammate", () => rail.debugRemoveFakeTeammate());
ipcMain.handle("debug:replayEnterAnimation", () => replayEnterAnimation());
ipcMain.handle("debug:fireCollision", () => runDebugFireCollision());
ipcMain.handle("debug:fireCollisionOnFake", () => runDebugFireCollisionOnFake());
ipcMain.handle("collision:dismiss", (_e, login: string) => {
  if (typeof login === "string" && login.length > 0) rail.dismissCollision(login);
});

// DEV ONLY — fire a synthetic collision against a peer in the rail, picking
// a real file from one of their live sessions so the in-row banner has
// something to attach to. Both ring + popover banner are guaranteed to
// appear together (or neither does — see verifyAndMarkCollision).

async function runDebugFireCollision(): Promise<void> {
  const heads = rail.list();
  // Prefer the head whose popover is currently open — that way the warning
  // shows up in the popover you're already looking at. Fall back to other
  // peers if the selected one has no usable sessions.
  const selfHead = heads[0];
  const ordered = selectedHeadId
    ? [
        ...heads.filter((h) => h.id === selectedHeadId),
        ...heads.filter((h) => h.id !== selectedHeadId),
      ]
    : heads;
  console.log(
    `[debug] runDebugFireCollision invoked, rail=${heads.length} selected=${selectedHeadId ?? "(none)"}`,
  );

  // Find the first peer whose live (non-ENDED) sessions contain a real file
  // we can collide on. Routes through the same verify-and-mark helper used
  // by the WS path so debug + production produce identical UI guarantees.
  for (const head of ordered) {
    if (head === selfHead) continue;
    const login = rail.parseUserHeadId(head.id);
    if (!login) continue;
    if (!sessionCache.has(head.id)) {
      try {
        await fetchSessionsForHead(head.id);
      } catch {
        continue;
      }
    }
    const sessions = sessionCache.get(head.id);
    const realFile = pickRealFileFromSessions(sessions);
    if (realFile == null) continue;
    console.log(`[debug] fireCollision → ${login} on ${realFile}`);
    await verifyAndMarkCollision(login, realFile);
    return;
  }
  console.warn(
    "[debug] fireCollision: no peer in rail has a live session with edited/written files — try opening Cmd+Shift+' (collision-on-fake) instead, or wait for a teammate to start editing.",
  );
}

/**
 * Returns the first real file path appearing in any of the peer's *live*
 * (non-ENDED) sessions' topFilesEdited/Written. Returns null when none
 * found — the caller should try the next peer rather than fall back to a
 * hardcoded path that won't match any session predicate.
 */
function pickRealFileFromSessions(sessions: InfoSession[] | undefined): string | null {
  if (!sessions) return null;
  const fields: Array<keyof Pick<InfoSession, "topFilesEdited" | "topFilesWritten">> = [
    "topFilesEdited",
    "topFilesWritten",
  ];
  for (const field of fields) {
    for (const s of sessions) {
      if (s.state === "ended") continue;
      const top = s[field];
      if (!Array.isArray(top) || top.length === 0) continue;
      for (const entry of top) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length > 0) {
          return entry[0];
        }
      }
    }
  }
  return null;
}

async function runDebugFireCollisionOnFake(): Promise<void> {
  console.log(`[debug] runDebugFireCollisionOnFake invoked`);
  rail.debugAddFakeTeammate();
  // Fakes have no backend sessions to attach a popover banner to, so we
  // bypass verification and stamp the ring directly. Hovering the fake
  // bubble shows nothing useful — this path is only for testing the
  // ring/halo animation in isolation.
  const heads = rail.list();
  for (let i = heads.length - 1; i > 0; i--) {
    const login = rail.parseUserHeadId(heads[i].id);
    if (!login || !login.startsWith("debug_")) continue;
    rail.markCollision(login, "src/example.ts");
    return;
  }
}

function replayEnterAnimation(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send("debug:replayEnter");
}

rail.onChange((next) => {
  heads = next;
  // Drop info-window selection if the targeted head left the graph.
  if (selectedHeadId && !findHead(selectedHeadId)) {
    hideInfoNow();
  }
  debugBackfillTimestamps();
  // Keep the grace timestamp current while the user is working, so "15 min
  // after the last session ended" measures from the most recent live poll.
  if (rail.isSelfLive()) bumpActivity();
  if (heads.length === 0) {
    overlayWindow?.close();
    overlayWindow = null;
  } else {
    ensureOverlay();
    resizeOverlay();
    resolveRailVisibility();
    repositionInfoIfVisible();
    repositionChatIfVisible();
  }
  // Pre-warm the session cache so hover-to-show is instant.
  for (const h of heads) {
    if (!sessionCache.has(h.id)) void fetchSessionsForHead(h.id);
  }
  broadcastHeads();
});

ipcMain.handle(
  "heads:showInfo",
  (_e, headId: string, bubbleScreen?: { x: number; y: number }): void => {
    if (!findHead(headId)) return;
    void showInfo(headId, bubbleScreen);
  },
);

ipcMain.handle("info:hide", (): void => scheduleHideInfo());
ipcMain.handle("info:hoverEnter", (): void => cancelHideInfo());
ipcMain.handle("info:hoverLeave", (): void => scheduleHideInfo());

ipcMain.handle("overlay:setLength", (_e, length: number): void => {
  if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) return;
  const next = Math.round(length);
  if (next === desiredOverlayLength) return;
  desiredOverlayLength = next;
  resizeOverlay();
});

ipcMain.handle("chat:toggle", (): void => toggleChat());
ipcMain.handle("chat:hide", (): void => hideChat());

ipcMain.handle("response:open", (_e, message: string): void => {
  showResponse({ kind: "message", message });
});

ipcMain.handle(
  "response:openThread",
  (_e, thread: Extract<ResponseOpenPayload, { kind: "thread" }>["thread"]): void => {
    showResponse({ kind: "thread", thread });
  },
);

ipcMain.handle(
  "chat:openSessionCard",
  (_e, payload: { sessionId: string; login: string }): void => {
    const headId = rail.userHeadId(payload.login);
    if (!findHead(headId)) return;
    void showInfo(headId, undefined, payload.sessionId);
  },
);

ipcMain.handle(
  "chat:ask",
  (
    _e,
    messages: Parameters<typeof backend.askChat>[0],
    threadId?: Parameters<typeof backend.askChat>[1],
  ) => backend.askChat(messages, threadId),
);

ipcMain.handle("chat:history", () => backend.fetchChatHistory());

ipcMain.handle("chat:questionsForLogin", (_e, login: string) =>
  backend.fetchQuestionsForLogin(login),
);

ipcMain.handle("chat:gerund", (_e, prompt: string) => backend.fetchChatGerunds(prompt));

// -------- Dock to edge (drag → release → snap) --------

function overlayDisplay(): Electron.Display {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return screen.getPrimaryDisplay();
  }
  return screen.getDisplayMatching(overlayWindow.getBounds());
}

function currentDock(): DockConfig {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return { orientation: "vertical", side: "end" };
  }
  const b = overlayWindow.getBounds();
  const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  return dockFromPoint(center, overlayDisplay());
}

function computeDockBounds(dock: DockConfig): Electron.Rectangle {
  const display = overlayDisplay();
  return computeDockBoundsOn(display, dock, effectiveOverlayLength(dock.orientation, display));
}

function ensureDockPlaceholder(): BrowserWindow {
  if (dockPlaceholderWindow && !dockPlaceholderWindow.isDestroyed()) {
    return dockPlaceholderWindow;
  }
  // Radius matches the overlay's pill cap (half the short axis = OVERLAY_WIDTH/2).
  // Both orientations share the same short axis, so the same radius gives
  // perfect semi-circle caps whether the placeholder is tall or wide.
  const radius = Math.round(OVERLAY_WIDTH / 2);
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%;}
    .pill{
      position:fixed;inset:0;box-sizing:border-box;
      border:2px dashed rgba(255,255,255,0.55);
      border-radius:${radius}px;
      background:rgba(255,255,255,0.05);
    }
  </style></head><body><div class="pill"></div></body></html>`;
  const initialSize = overlaySize(heads.length, "vertical");
  dockPlaceholderWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
    },
  });
  dockPlaceholderWindow.setAlwaysOnTop(true, "floating");
  dockPlaceholderWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  dockPlaceholderWindow.setIgnoreMouseEvents(true);
  void dockPlaceholderWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  dockPlaceholderWindow.on("closed", () => {
    dockPlaceholderWindow = null;
  });
  return dockPlaceholderWindow;
}

function updateDockPlaceholder(): void {
  const ph = ensureDockPlaceholder();
  ph.setBounds(computeDockBounds(currentDock()));
  if (!ph.isVisible()) ph.showInactive();
}

function hideDockPlaceholder(): void {
  if (!dockPlaceholderWindow || dockPlaceholderWindow.isDestroyed()) return;
  if (dockPlaceholderWindow.isVisible()) dockPlaceholderWindow.hide();
}

ipcMain.handle("drag:start", (): void => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // A new drag cancels any in-flight dock tween.
  cancelOverlayAnimation();

  const cursor = screen.getCursorScreenPoint();
  const win = overlayWindow.getBounds();
  dragOffset = { dx: cursor.x - win.x, dy: cursor.y - win.y };
  isDraggingStack = true;
  // Kill any visible/pending info card so it doesn't trail the stack.
  hideInfoNow();
  updateDockPlaceholder();

  if (dragTicker) clearInterval(dragTicker);
  dragTicker = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !dragOffset) return;
    const p = screen.getCursorScreenPoint();
    overlayWindow.setPosition(p.x - dragOffset.dx, p.y - dragOffset.dy);
    repositionInfoIfVisible();
    repositionChatIfVisible();
    updateDockPlaceholder();
  }, 16);
});

ipcMain.handle("drag:end", (): void => {
  if (dragTicker) clearInterval(dragTicker);
  dragTicker = null;
  dragOffset = null;
  hideDockPlaceholder();

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    isDraggingStack = false;
    saveOverlayPosition();
    return;
  }

  const target = computeDockBounds(currentDock());
  // Push the new dock to the overlay renderer first so flex direction + FLIP
  // tracking swap before the window resizes. The renderer will see the new
  // size via its resize event during the animation, but with the right flex
  // orientation already in place.
  sendOverlayConfig();
  // Keep isDraggingStack on through the slide so bubble hovers under the
  // moving window don't pop the info card mid-tween.
  animateOverlayTo(overlayWindow, target, DOCK_ANIM_MS, {
    onTick: () => {
      repositionInfoIfVisible();
      repositionChatIfVisible();
    },
    onDone: () => {
      isDraggingStack = false;
      saveOverlayPosition();
    },
  });
});

ipcMain.handle("app:openMain", (): void => {
  showMainWindow();
  hideTrayPopup();
});

ipcMain.handle("app:openAgentCreator", (): void => {
  const win = showMainWindow();
  hideTrayPopup();
  if (win.isDestroyed()) return;
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send("agents:openCreator");
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
});

ipcMain.handle("app:quit", (): void => app.quit());

ipcMain.handle("clipboard:writeText", (_e, text: string): void => clipboard.writeText(text ?? ""));
ipcMain.handle("shell:openExternal", async (_e, url: string): Promise<void> => {
  await shell.openExternal(url);
});

ipcMain.handle(
  "dialog:selectDirectory",
  async (_e, defaultPath?: string): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Choose working directory",
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  },
);

ipcMain.handle("window:requestResize", (e, height: number): void => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  let maxForWin = RESIZE_MAX;
  if (win === infoWindow) {
    const { height: screenH } = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    maxForWin = Math.min(INFO_MAX_ABSOLUTE, Math.floor(screenH * INFO_MAX_SCREEN_FRACTION));
  }
  const h = Math.max(RESIZE_MIN, Math.min(maxForWin, Math.round(height)));

  if (win === infoWindow) {
    if (h === infoCurrentHeight) return;
    infoCurrentHeight = h;
    // Remember the height for this head so the next time it's shown we land
    // at the right size on first paint.
    if (selectedHeadId) infoHeightByHead.set(selectedHeadId, h);

    if (selectedHeadId) {
      // Smoothly retween the open panel to the new height.
      repositionInfoIfVisible();
    } else {
      // Nothing selected (renderer sending a resize during fade-out or
      // initial load) — apply the height so the next show lands correctly.
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    }
  } else if (win === getTrayPopup()) {
    const b = win.getBounds();
    if (h === b.height) return;
    // Tray popup is anchored at top — height grows downward.
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  }
});

async function fetchSessionsForHead(headId: string): Promise<InfoSession[]> {
  const cached = sessionCache.get(headId);
  if (cached) return cached;

  const state = backend.getAuthState();
  if (!state.signedIn) return [];

  const login = rail.parseUserHeadId(headId);
  if (login) {
    try {
      const sessions =
        state.user.githubLogin === login
          ? await backend.listOwnSessions()
          : await backend.listFeedSessionsForUser(login);
      sessionCache.set(headId, sessions);
      return sessions;
    } catch {
      return [];
    }
  }

  return [];
}

ipcMain.handle("sessions:forHead", async (_e, headId: string): Promise<InfoSession[]> => {
  return fetchSessionsForHead(headId);
});

// Preload sessions for a head on hover to avoid flicker when opening info window
ipcMain.handle("sessions:preload", async (_e, headId: string): Promise<void> => {
  void fetchSessionsForHead(headId);
});

ipcMain.handle("agentSessions:forAgent", async (_e, agentId: string) =>
  agentIngest.listForAgent(agentId),
);

ipcMain.handle("mcp:install", (_e, target: McpTarget, options?: unknown) =>
  installMcp.install(target, options as Parameters<typeof installMcp.install>[1]),
);
ipcMain.handle("mcp:uninstall", (_e, target: McpTarget) => installMcp.uninstall(target));
ipcMain.handle("mcp:status", () => installMcp.status());
ipcMain.handle("mcp:url", () => installMcp.mcpUrl());
ipcMain.handle("mcp:detailForHead", (_e, _headId: string) => {
  void _e;
  void _headId;
  return Promise.resolve(null);
});

ipcMain.handle("github:isConfigured", () => githubAuth.isConfigured());
ipcMain.handle("github:getState", () => githubAuth.getState());
ipcMain.handle("github:connect", () => githubAuth.startConnect());
ipcMain.handle("github:cancelConnect", () => githubAuth.cancelConnect());
ipcMain.handle("github:disconnect", () => githubAuth.disconnect());

ipcMain.handle("agents:isConfigured", () => anthropic.isConfigured());
ipcMain.handle("agents:setApiKey", async (_e, key: string): Promise<void> => {
  await anthropic.setApiKey(key);
});
ipcMain.handle("agents:clearApiKey", () => anthropic.clearApiKey());
ipcMain.handle("agents:list", () => agentStore.list().map(toAgentSummary));
ipcMain.handle("agents:create", async (_e, input: CreateAgentInput): Promise<AgentSummary> => {
  const visibility = input.visibility ?? "private";
  if (input.mode === "local") {
    const created = localAgent.createAgent(input);
    const row: LocalAgent = {
      id: created.id,
      name: created.name,
      description: created.description,
      systemPrompt: created.systemPrompt,
      model: created.model,
      createdAt: Date.now(),
      sessions: [],
      mode: "local",
      cwd: created.cwd,
      visibility,
      mcpServers: [],
    };
    agentStore.add(row);
    return toAgentSummary(row);
  }

  const created = await anthropic.createAgent({
    name: input.name,
    description: input.description,
    systemPrompt: input.systemPrompt,
    model: input.model,
    mcpServers: input.mcpServers,
  });
  const row: LocalAgent = {
    id: created.id,
    name: created.name,
    description: created.description,
    systemPrompt: created.systemPrompt,
    model: created.model,
    createdAt: Date.now(),
    sessions: [],
    mode: "cloud",
    visibility,
    mcpServers: input.mcpServers ?? [],
  };
  agentStore.add(row);
  return toAgentSummary(row);
});
ipcMain.handle(
  "agents:update",
  async (_e, id: string, input: UpdateAgentInput): Promise<AgentSummary> => {
    const existing = agentStore.get(id);
    if (!existing) throw new Error("Unknown agent");

    const name = input.name.trim();
    const systemPrompt = input.systemPrompt.trim();
    if (!name) throw new Error("Agent name is required.");
    if (!systemPrompt) throw new Error("Agent prompt is required.");

    const patch = {
      name,
      description: input.description?.trim() || undefined,
      systemPrompt,
      model: input.model?.trim() || existing.model,
      cwd: isLocalAgent(existing) ? input.cwd?.trim() || undefined : existing.cwd,
      visibility: input.visibility ?? existing.visibility ?? "private",
      mcpServers: isLocalAgent(existing)
        ? existing.mcpServers
        : (input.mcpServers ?? existing.mcpServers ?? []),
    };

    if (!isLocalAgent(existing)) {
      const updated = await anthropic.updateAgent(id, {
        name: patch.name,
        description: patch.description,
        systemPrompt: patch.systemPrompt,
        model: patch.model,
        mcpServers: patch.mcpServers,
      });
      const row = agentStore.update(id, {
        ...patch,
        name: updated.name,
        description: updated.description,
        systemPrompt: updated.systemPrompt,
        model: updated.model,
      });
      if (!row) throw new Error("Unknown agent");
      return toAgentSummary(row);
    }

    const row = agentStore.update(id, patch);
    if (!row) throw new Error("Unknown agent");
    return toAgentSummary(row);
  },
);
ipcMain.handle("agents:remove", async (_e, id: string): Promise<void> => {
  const row = agentStore.get(id);
  if (row && isLocalAgent(row)) {
    for (const s of row.sessions) localAgent.archiveSession(s.id);
  } else {
    try {
      await anthropic.archiveAgent(id);
    } catch (err) {
      console.warn("archive agent failed (continuing):", err);
    }
  }
  streamingAgents.delete(id);
  agentStore.remove(id);
});
ipcMain.handle(
  "agents:history",
  async (
    _e,
    agentId: string,
    sessionId?: string | null,
    cursor?: string | null,
  ): Promise<AgentHistoryPage> => {
    const row = agentStore.get(agentId);
    const targetSessionId = sessionId ?? row?.activeSessionId;
    if (!row || !targetSessionId) return { msgs: [], nextCursor: null };
    if (isLocalAgent(row)) {
      return localAgent.loadSessionMessages(targetSessionId, cursor);
    }
    try {
      return await anthropic.loadSessionMessages(targetSessionId, cursor);
    } catch (err) {
      console.warn("history load failed:", err);
      return { msgs: [], nextCursor: null };
    }
  },
);
ipcMain.handle(
  "agents:send",
  async (_e, agentId: string, text: string, requestedSessionId?: string | null) => {
    const row = agentStore.get(agentId);
    if (!row) throw new Error("Unknown agent");
    streamingAgents.add(agentId);
    try {
      let sessionId = requestedSessionId ?? row.activeSessionId;
      if (!sessionId) {
        sessionId = isLocalAgent(row)
          ? localAgent.localSessionId()
          : (await anthropic.startSession(agentId)).sessionId;
        const createdAt = Date.now();
        agentStore.addSession(agentId, { id: sessionId, createdAt });
        agentIngest.upsertSessionStart(row, sessionId, createdAt);
        emitSessionsChange(agentId);
      } else if (requestedSessionId) {
        agentStore.setActiveSession(agentId, requestedSessionId);
      }

      const latestRow = agentStore.get(agentId) ?? row;
      const session = latestRow.sessions.find((s) => s.id === sessionId);
      if (session && !session.title) {
        const title = truncateTitle(text);
        agentStore.setSessionTitle(agentId, sessionId, title);
        emitSessionsChange(agentId);
        if (!isLocalAgent(row)) {
          anthropic.updateSessionTitle(sessionId, title).catch((err) => {
            console.warn("server title update failed:", err);
          });
        }
      }

      const streamSessionId = sessionId;
      const handleEvent = (e: anthropic.AgentStreamEvent): void => {
        const payload: AgentStreamEvent = { ...e, agentId };
        broadcastAgentEvent(payload);
        if (e.kind === "usage") {
          agentStore.addSessionUsage(agentId, streamSessionId, {
            input: e.input,
            output: e.output,
          });
          emitSessionsChange(agentId);
        }
        if (e.kind === "done" || e.kind === "error") {
          streamingAgents.delete(agentId);
        }
      };

      if (isLocalAgent(row)) {
        void localAgent.sendMessage(streamSessionId, text, row, handleEvent, () =>
          emitSessionsChange(agentId),
        );
      } else {
        void anthropic.sendMessage(streamSessionId, text, handleEvent);
      }
    } catch (err) {
      streamingAgents.delete(agentId);
      throw err;
    }
  },
);
ipcMain.handle("agents:listSessions", (_e, agentId: string): AgentSessionSummary[] => {
  const row = agentStore.get(agentId);
  if (row && !isLocalAgent(row)) void refreshSessionsFromServer(agentId);
  return row?.sessions ?? [];
});

const pendingArchive = new Set<string>();
const PENDING_ARCHIVE_TTL_MS = 30_000;

async function refreshSessionsFromServer(agentId: string): Promise<void> {
  try {
    const server = await anthropic.listAgentSessions(agentId);
    const active = server.filter((s) => s.archivedAt == null && !pendingArchive.has(s.id));
    agentStore.reconcileSessions(
      agentId,
      active.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        title: s.title ?? undefined,
      })),
    );
    emitSessionsChange(agentId);
  } catch (err) {
    console.warn("session reconcile failed:", err);
  }
}

ipcMain.handle("agents:popOut", (_e, agentId: string, sessionId: string): void => {
  agentStore.setActiveSession(agentId, sessionId);
  showResponse({ kind: "agent", agentId, sessionId });
});

ipcMain.handle(
  "agents:removeSession",
  async (_e, agentId: string, sessionId: string): Promise<void> => {
    const row = agentStore.get(agentId);
    if (row && isLocalAgent(row)) {
      agentStore.removeSession(agentId, sessionId);
      emitSessionsChange(agentId);
      localAgent.archiveSession(sessionId);
      return;
    }

    pendingArchive.add(sessionId);
    setTimeout(() => pendingArchive.delete(sessionId), PENDING_ARCHIVE_TTL_MS);

    const isTeamCloud = !!row && (row.visibility ?? "private") === "team";
    const startedAtMs = row?.sessions.find((s) => s.id === sessionId)?.createdAt ?? Date.now();
    const agentSnapshot = row;

    agentStore.removeSession(agentId, sessionId);
    emitSessionsChange(agentId);

    try {
      await anthropic.archiveSession(sessionId);
    } catch (err) {
      console.warn("archive session failed (continuing):", err);
    }

    if (isTeamCloud && agentSnapshot) {
      void finalizeTeamSession(agentSnapshot, sessionId, startedAtMs);
    }
  },
);

async function finalizeTeamSession(
  agent: LocalAgent,
  sessionId: string,
  startedAtMs: number,
): Promise<void> {
  const endedAt = new Date().toISOString();
  const base = {
    agentId: agent.id,
    sessionId,
    mode: "cloud" as const,
    visibility: "team" as const,
    name: agent.name,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt,
    lastActivity: endedAt,
  };
  try {
    const { summary, model } = await summarize.summarizeCloudSession(sessionId);
    await agentIngest.upsertSession({
      ...base,
      summary,
      summaryModel: model,
      summaryTs: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[summarize] failed:", err);
    await agentIngest.upsertSession(base);
  }
}

ipcMain.handle("agents:newSession", async (_e, agentId: string): Promise<AgentSessionSummary> => {
  const row = agentStore.get(agentId);
  if (!row) throw new Error("Unknown agent");
  const id = isLocalAgent(row)
    ? localAgent.localSessionId()
    : (await anthropic.startSession(agentId)).sessionId;
  const session: AgentSessionSummary = { id, createdAt: Date.now() };
  agentStore.addSession(agentId, session);
  agentIngest.upsertSessionStart(row, id, session.createdAt);
  emitSessionsChange(agentId);
  return session;
});

ipcMain.handle("agents:selectSession", (_e, agentId: string, sessionId: string): void => {
  agentStore.setActiveSession(agentId, sessionId);
  emitSessionsChange(agentId);
});

ipcMain.handle(
  "agents:ensureSessionUsage",
  async (_e, agentId: string, sessionId: string): Promise<void> => {
    const row = agentStore.get(agentId);
    const session = row?.sessions.find((s) => s.id === sessionId);
    if (!row || !session || session.tokens) return;
    if (isLocalAgent(row)) return;
    try {
      const total = await anthropic.sumSessionUsage(sessionId);
      agentStore.setSessionUsage(agentId, sessionId, total);
      emitSessionsChange(agentId);
    } catch (err) {
      console.warn("backfill usage failed:", err);
    }
  },
);

function truncateTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 60 ? clean : clean.slice(0, 57) + "...";
}

function emitSessionsChange(agentId: string): void {
  const sessions = agentStore.get(agentId)?.sessions ?? [];
  const payload = { agentId, sessions };
  for (const w of agentConsumerWindows()) {
    w.webContents.send("agents:sessionsChange", payload);
  }
}

ipcMain.handle("chatheads:getAuthState", () => chatheadsAuth.getAuthState());
ipcMain.handle("chatheads:signIn", () => chatheadsAuth.signIn());
ipcMain.handle("chatheads:cancelSignIn", () => chatheadsAuth.cancelSignIn());
ipcMain.handle("chatheads:signOut", () => chatheadsAuth.signOut());

// Push a presence update into the info window only while it's showing the
// head whose login just changed. Fallback poll lives in the renderer.
peerPresence.onChange(({ login, presence }) => {
  if (!infoWindow || infoWindow.isDestroyed() || !selectedHeadId) return;
  const shownLogin = rail.parseUserHeadId(selectedHeadId);
  if (shownLogin !== login) return;
  infoWindow.webContents.send("info:presence", { login, spotify: presence });
});

ipcMain.handle("spotify:forLogin", (_e, login: string) => peerPresence.get(login));

// slashtalk backend
ipcMain.handle("backend:getAuthState", () => backend.getAuthState());
ipcMain.handle("backend:signIn", () => backend.signIn());
ipcMain.handle("backend:cancelSignIn", () => backend.cancelSignIn());
ipcMain.handle("backend:signOut", async () => {
  await backend.signOut();
  localRepos.clearOnSignOut();
});
ipcMain.handle("backend:signOutEverywhere", async () => {
  await backend.signOutEverywhere();
  localRepos.clearOnSignOut();
});

function applySyncForAuth(signedIn: boolean): void {
  if (signedIn) {
    void uploader.start();
    void heartbeat.start();
    updateSpotifyRunning();
    void peerPresence.start();
    ws.start();
    for (const target of ["claude-code", "codex"] as const) {
      void installMcp
        .install(target)
        .catch((err) => console.warn(`installMcp.install ${target} failed:`, err));
    }
  } else {
    heartbeat.stop();
    uploader.reset();
    updateSpotifyRunning();
    peerPresence.stop();
    ws.stop();
    for (const target of ["claude-code", "codex"] as const) {
      void installMcp
        .uninstall(target)
        .catch((err) => console.warn(`installMcp.uninstall ${target} failed:`, err));
    }
  }
}

ws.onPrActivity((msg) => {
  console.log(
    `[ws] pr_activity ${msg.action} by ${msg.login} on ${msg.repoFullName}#${msg.number}`,
  );
  rail.markPrActivity(msg.login);
});

ws.onCollisionDetected((msg) => {
  console.log(
    `[ws] collision_detected on ${msg.file_path} (trigger=${msg.trigger.githubLogin} others=${msg.others.map((o) => o.githubLogin).join(",")})`,
  );
  const state = backend.getAuthState();
  const selfLogin = state.signedIn ? state.user.githubLogin : null;
  // Stamp every involved peer (trigger + others) — but verify each one's
  // session data actually contains the file before painting the ring. This
  // is what keeps ring + popover warning in lockstep: if no live session
  // for a peer touches the file (stale cache, races, weird edge cases),
  // we don't paint a ring with no explanation.
  if (msg.trigger.githubLogin !== selfLogin) {
    void verifyAndMarkCollision(msg.trigger.githubLogin, msg.file_path);
  }
  for (const other of msg.others) {
    if (other.githubLogin === selfLogin) continue;
    void verifyAndMarkCollision(other.githubLogin, msg.file_path);
  }
});

/** Refresh the peer's session cache, then mark a collision only if at least
 *  one live (non-ENDED) session of theirs has the file in topFilesEdited or
 *  topFilesWritten — the same predicate the popover uses to render the
 *  in-row warning. Single source of truth: ring + warning live and die
 *  together. Used by both the WS path (production) and the debug picker. */
async function verifyAndMarkCollision(login: string, filePath: string): Promise<void> {
  const headId = rail.userHeadId(login);
  // Drop the cache so we re-fetch with the latest topFiles. The server fires
  // collision_detected after session_updated but the WS messages can arrive
  // out of order or before our fetch completes; an explicit refresh
  // guarantees we see the post-update aggregates.
  sessionCache.delete(headId);
  let sessions: InfoSession[];
  try {
    sessions = await fetchSessionsForHead(headId);
  } catch (err) {
    console.warn(`[collision] verify failed to fetch sessions for ${login}:`, err);
    return;
  }
  if (!anyLiveSessionTouchesFile(sessions, filePath)) {
    console.warn(
      `[collision] verify: no live session of ${login} contains ${filePath} — skipping ring`,
    );
    return;
  }
  rail.markCollision(login, filePath);
}

function anyLiveSessionTouchesFile(sessions: InfoSession[], filePath: string): boolean {
  for (const s of sessions) {
    if (s.state === "ended") continue;
    const sets = [s.topFilesEdited, s.topFilesWritten];
    for (const set of sets) {
      if (!Array.isArray(set)) continue;
      for (const entry of set) {
        if (Array.isArray(entry) && entry[0] === filePath) return true;
      }
    }
  }
  return false;
}

// Local uploader ingestion invalidates the self-head cache synchronously —
// faster than waiting for the server-side WS echo for your own sessions.
uploader.onIngested(() => {
  const state = backend.getAuthState();
  if (!state.signedIn) return;
  sessionCache.delete(rail.userHeadId(state.user.githubLogin));
});

backend.onChange((state) => applySyncForAuth(state.signedIn));

ws.onSessionInsightsUpdated((msg) => {
  console.log(
    `[insights] ${msg.analyzer} ready for session ${msg.session_id.slice(0, 8)} (repo=${msg.repo_id})`,
    msg.output,
  );
  scheduleInfoRefresh(msg.session_id);
  broadcastToMain("ws:sessionInsightsUpdated", msg);
});

ws.onSessionUpdated((msg) => {
  // Drop the owner's cache so a non-selected head goes stale-free on next
  // hover. scheduleInfoRefresh then coalesces any UI refresh for the
  // currently-selected head across bursty events.
  sessionCache.delete(rail.userHeadId(msg.github_login));
  rail.refreshSoon();
  scheduleInfoRefresh(msg.session_id);
  broadcastToMain("ws:sessionUpdated", msg);
});

// `session_updated` fires on every ingest batch — potentially many per second
// during an active session. Coalesce refreshes so the info window re-renders
// at most once per REFRESH_DEBOUNCE_MS regardless of WS traffic.
const REFRESH_DEBOUNCE_MS = 300;
let refreshTimer: NodeJS.Timeout | null = null;

function scheduleInfoRefresh(sessionId: string | null): void {
  if (!selectedHeadId) return;
  if (!infoWindow || infoWindow.isDestroyed() || !infoWindow.isVisible()) {
    return;
  }
  // If we know which session changed, skip refreshes whose session isn't in
  // the currently-shown head. Fall through when we can't tell.
  if (sessionId) {
    const cached = sessionCache.get(selectedHeadId);
    if (cached && !cached.some((s) => s.id === sessionId)) return;
  }
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshInfoNow();
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshInfoNow(): Promise<void> {
  if (!selectedHeadId) return;
  if (!infoWindow || infoWindow.isDestroyed() || !infoWindow.isVisible()) {
    return;
  }
  const head = heads.find((h) => h.id === selectedHeadId);
  if (!head) return;
  // Only drop the selected head's cache; other heads stay warm until clicked.
  sessionCache.delete(head.id);
  try {
    const sessions = await fetchSessionsForHead(head.id);
    if (selectedHeadId !== head.id) return;
    if (!infoWindow || infoWindow.isDestroyed()) return;
    const refreshLogin = rail.parseUserHeadId(head.id);
    infoWindow.webContents.send("info:show", {
      head,
      sessions,
      spotify: refreshLogin ? peerPresence.get(refreshLogin) : null,
    });
  } catch (e) {
    console.warn("[ws] refreshInfoNow failed:", e);
  }
}
ipcMain.handle("backend:listTrackedRepos", () => localRepos.list());
ipcMain.handle("backend:addLocalRepo", () => localRepos.addLocalRepo());
ipcMain.handle("backend:removeLocalRepo", (_e, repoId: number) =>
  localRepos.removeLocalRepo(repoId),
);

// -------- Tray repo-picker (tracked local repos) --------

ipcMain.handle("trackedRepos:selection", () => [...localRepos.selectedRepoIds()]);
ipcMain.handle("trackedRepos:toggle", (_e, repoId: number) => [
  ...localRepos.toggleSelected(repoId),
]);

function broadcastToMain(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// Tray popup (statusbar renderer) is the primary consumer of orgs:* /
// repos:* push channels. We still broadcast to main so any future settings
// UI on the main window stays in sync without extra plumbing.
function broadcastToTrayAndMain(channel: string, payload: unknown): void {
  for (const w of [getMainWindow(), getTrayPopup()]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function agentConsumerWindows(): BrowserWindow[] {
  return [getMainWindow(), infoWindow, getResponseWindow()].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  );
}

function broadcastAgentEvent(event: AgentStreamEvent): void {
  for (const w of agentConsumerWindows()) {
    w.webContents.send("agents:event", event);
  }
}

backend.onChange((state) => broadcastToMain("backend:authState", state));
// Tray popup shows sign-in state too — mirror to it so the CTA flips live.
backend.onChange((state) => {
  const popup = getTrayPopup();
  if (popup && !popup.isDestroyed()) popup.webContents.send("backend:authState", state);
});
localRepos.onChange((repos) => broadcastToTrayAndMain("backend:trackedRepos", repos));
localRepos.onSelectionChange((ids) =>
  broadcastToTrayAndMain("trackedRepos:selectionChange", [...ids]),
);
chatheadsAuth.onChange((state) => broadcastToMain("chatheads:authState", state));
githubAuth.onChange((state) => broadcastToMain("github:state", state));
anthropic.onConfiguredChange((configured) => broadcastToMain("agents:configured", configured));
agentStore.onChange((agents) => broadcastToMain("agents:listChange", agents.map(toAgentSummary)));

// -------- Lifecycle --------

// Rail derives lastActivityAt from /api/feed sessions directly, no backfill needed.
function debugBackfillTimestamps(): void {
  // No-op; kept for reference.
}

configureRailState({
  getOverlay: () => overlayWindow,
  getMainWindow,
  getTrayPopup,
});
configureChat({
  getOverlay: () => overlayWindow,
  getCurrentDock: currentDock,
  onVisibilityChange: broadcastChatVisible,
  resolveRailVisibility,
});
configureResponse({ onClose: hideChat });
configureHoverPolling({
  getOverlay: () => overlayWindow,
  isRailPinned: getRailPinned,
  isAppFocused: appIsFocused,
});
configureRailVisibility({
  getOverlay: () => overlayWindow,
  isRailPinned: getRailPinned,
  isSessionOnlyMode: getRailSessionOnlyMode,
  isSelfLive: () => rail.isSelfLive(),
  isChatVisible,
});

app.whenReady().then(async () => {
  // Ensure Slashtalk shows in Cmd+Tab and the Dock. macOS default is
  // "regular" but we set it explicitly, and force-show the dock icon in case
  // something demoted us to accessory mode.
  if (process.platform === "darwin") {
    console.log("[app] setActivationPolicy(regular) + dock.show()");
    app.setActivationPolicy("regular");
    void app.dock?.show();
  }
  backend.restore();
  await backend.validateStoredSession();
  chatheadsAuth.restore();
  anthropic.restore();
  githubAuth.restore();
  localRepos.restore();
  void mcpProxy.start().catch((err) => console.warn("[localMcpProxy] start failed:", err));
  // In session-only mode the tray click is the user's escape hatch: it
  // force-shows the rail and resets the 15-min grace timer. Outside that
  // mode the lastActivityTs bump is inert — resolveRailVisibility ignores
  // it while pinned or with session-only off.
  createTray({
    onClick: (bounds) => {
      bumpActivity();
      toggleTrayPopup(bounds);
      resolveRailVisibility();
    },
  });
  rail.start();
  selfSession.start();
  applySyncForAuth(backend.getAuthState().signedIn);

  // DEV ONLY — rail test shortcuts. Remove before shipping.
  if (!app.isPackaged) {
    const bindings: Array<[string, () => void]> = [
      ["CommandOrControl+Shift+R", () => rail.debugShuffleRail()],
      ["CommandOrControl+Shift+J", () => rail.debugAddFakeTeammate()],
      ["CommandOrControl+Shift+L", () => rail.debugRemoveFakeTeammate()],
      ["CommandOrControl+Shift+K", () => replayEnterAnimation()],
      // Fire a synthetic collision against the first peer (or do nothing if
      // the rail is empty). Picks a real file from the peer's cached sessions
      // so the in-row banner attaches. Using semicolon to avoid OS-level
      // bindings that capture Cmd+Shift+letter combos.
      ["CommandOrControl+Shift+;", () => void runDebugFireCollision()],
      // Same, but spawns a fake teammate first so a single shortcut on an
      // empty rail still produces a visible rail-ring animation.
      ["CommandOrControl+Shift+'", () => void runDebugFireCollisionOnFake()],
    ];
    for (const [accel, fn] of bindings) {
      const ok = globalShortcut.register(accel, fn);
      console.log(`[debug] shortcut ${accel}: ${ok ? "registered" : "FAILED"}`);
    }
  }
});

app.on("before-quit", () => {
  // Flag read by mainWindow's "close" handler to allow actual destruction
  // during app quit (otherwise close is preventDefault'd and the app can't
  // shut down cleanly).
  appState().isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void mcpProxy.stop();
});

// Keep the app alive when all windows close — the mere presence of a
// subscriber that doesn't call app.quit() suppresses the default quit.
// Mirrors applicationShouldTerminateAfterLastWindowClosed = false.
app.on("window-all-closed", () => {});

app.on("activate", () => {
  // Standard macOS reopen semantics: clicking the dock icon re-shows the
  // main window — covering the (now-rare) case where it was actually destroyed.
  showMainWindow();
});

// Unpinned mode: rail follows app focus. Float when active so hover works,
// drop to normal when blurred so it sits behind other apps.
app.on("did-become-active", () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (getRailPinned()) return;
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.moveTop();
});

app.on("did-resign-active", () => {
  // Re-assert regular activation policy so the app survives the transition
  // (macOS demotes us to accessory when the only visible window is a
  // normal-level NSPanel).
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    void app.dock?.show();
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (getRailPinned()) return;
  overlayWindow.setAlwaysOnTop(false);
});
