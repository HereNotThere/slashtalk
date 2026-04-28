import { app, BrowserWindow, nativeTheme, ipcMain, screen, globalShortcut } from "electron";
import type {
  ChatHead,
  DockConfig,
  DockOrientation,
  InfoSession,
  McpTarget,
  ResponseOpenPayload,
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
import * as githubAuth from "./githubDeviceAuth";
import * as peerPresence from "./peerPresence";
import * as peerLocations from "./peerLocations";
import { setMacCornerRadius, debugMacWindowState } from "./macCorners";
import {
  OVERLAY_WIDTH,
  computeDockBoundsOn,
  dockFromPoint,
  overlayLength,
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
  setRailCollapseInactive,
  setRailPinned,
  setRailSessionOnlyMode,
  setShowActivityTimestamps,
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
import { appState, loadRenderer, preloadPath } from "./windows/lib";
import {
  bumpActivity,
  configureRailVisibility,
  resolveRailVisibility,
} from "./windows/rail-visibility";
import { getMainWindow, showMainWindow } from "./windows/main";
import { configureResponse, showResponse } from "./windows/response";
import { createTray, getTrayPopup, toggleTrayPopup } from "./windows/tray";
import { broadcast, sendWhenLoaded } from "./windows/broadcast";
import { currentDock, registerDockDrag } from "./windows/dock-drag";
import * as info from "./windows/info";
import * as spotifyToggle from "./sync/spotify-toggle";
import * as userLocation from "./sync/user-location";
import { registerAgents } from "./ipc/agents";
import { registerDebug, registerDebugShortcuts } from "./ipc/debug";
import { registerShellIpc } from "./ipc/shell";

installMcp.configureInstaller({
  localProxySecret: getLocalMcpProxySecret,
});

const mcpProxy = createLocalMcpProxy({
  getToken: backend.getApiKey,
  getProxySecret: getLocalMcpProxySecret,
  remoteMcpUrl: installMcp.remoteMcpUrl,
});

const RESIZE_MIN = 60;
const RESIZE_MAX = 900;

const POSITION_KEY = "overlayPosition";

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

let heads: ChatHead[] = [];

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
    info.hideNow();
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
  broadcast(
    "heads:update",
    heads,
    overlayWindow,
    getMainWindow(),
    getTrayPopup(),
    info.getInfoWindow(),
  );
}

// -------- Overlay-renderer notifications --------

let lastSentDock: DockConfig | null = null;

function broadcastChatVisible(visible: boolean): void {
  broadcast("chat:state", { visible }, overlayWindow);
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
  sendWhenLoaded(overlayWindow, "overlay:config", dock);
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

spotifyToggle.register();

userLocation.register();

registerDebug({
  getOverlay: () => overlayWindow,
  getSelectedHeadId: info.getSelectedHeadId,
  getCachedSessions: info.getCachedSessions,
  fetchSessionsForHead: info.fetchSessionsForHead,
  verifyAndMarkCollision,
});

info.registerInfo({
  getOverlay: () => overlayWindow,
  getHeads: () => heads,
});

rail.onChange((next) => {
  heads = next;
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
    repositionChatIfVisible();
  }
  info.onHeadsChanged(heads);
  broadcastHeads();
});

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
  "chat:ask",
  async (
    _e,
    messages: Parameters<typeof backend.askChat>[0],
    threadId?: Parameters<typeof backend.askChat>[1],
  ) => {
    const result = await backend.askChat(messages, threadId);
    // The asker's question list just changed — drop the cache so the next
    // hover on their bubble (or rail self-bubble) refetches.
    const state = backend.getAuthState();
    if (state.signedIn) info.invalidateQuestionsForLogin(state.user.githubLogin);
    return result;
  },
);

ipcMain.handle("chat:history", () => backend.fetchChatHistory());

ipcMain.handle("chat:gerund", (_e, prompt: string) => backend.fetchChatGerunds(prompt));

registerDockDrag({
  getOverlay: () => overlayWindow,
  effectiveOverlayLength,
  onTick: () => {
    info.repositionIfVisible();
    repositionChatIfVisible();
  },
  onHideInfoNow: info.hideNow,
  onSendOverlayConfig: sendOverlayConfig,
  onSavePosition: saveOverlayPosition,
});

registerShellIpc();

ipcMain.handle("window:requestResize", (e, height: number): void => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  if (info.tryHandleResize(win, height)) return;

  const h = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(height)));
  if (win === getTrayPopup()) {
    const b = win.getBounds();
    if (h === b.height) return;
    // Tray popup is anchored at top — height grows downward.
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  }
});

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

registerAgents({ getInfoWindow: info.getInfoWindow });

ipcMain.handle("chatheads:getAuthState", () => chatheadsAuth.getAuthState());
ipcMain.handle("chatheads:signIn", () => chatheadsAuth.signIn());
ipcMain.handle("chatheads:cancelSignIn", () => chatheadsAuth.cancelSignIn());
ipcMain.handle("chatheads:signOut", () => chatheadsAuth.signOut());

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
    // Without these catches a thrown start() (e.g. fs.mkdir EACCES on
    // ~/.claude/projects, or an fs.watch that fails on a quirky filesystem)
    // is swallowed and the UI flips to "signed in" while nothing is actually
    // running — same shape the cursor-bot caught on heartbeat.
    void uploader.start().catch((err) => console.warn("uploader.start failed:", err));
    void heartbeat.start().catch((err) => console.warn("heartbeat.start failed:", err));
    spotifyToggle.updateSpotifyRunning();
    void peerPresence.start().catch((err) => console.warn("peerPresence.start failed:", err));
    void peerLocations.start().catch((err) => console.warn("peerLocations.start failed:", err));
    ws.start();
    for (const target of ["claude-code", "codex"] as const) {
      void installMcp
        .install(target)
        .catch((err) => console.warn(`installMcp.install ${target} failed:`, err));
    }
  } else {
    heartbeat.stop();
    uploader.reset();
    spotifyToggle.updateSpotifyRunning();
    peerPresence.stop();
    peerLocations.stop();
    ws.stop();
    info.clearQuestionsCache();
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
  info.invalidateSessionCache(headId);
  let sessions: InfoSession[];
  try {
    sessions = await info.fetchSessionsForHead(headId);
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
  info.invalidateSessionCache(rail.userHeadId(state.user.githubLogin));
});

backend.onChange((state) => applySyncForAuth(state.signedIn));

ws.onSessionInsightsUpdated((msg) => {
  console.log(
    `[insights] ${msg.analyzer} ready for session ${msg.session_id.slice(0, 8)} (repo=${msg.repo_id})`,
    msg.output,
  );
  info.scheduleRefresh(msg.session_id);
  broadcastToMain("ws:sessionInsightsUpdated", msg);
});

ws.onSessionUpdated((msg) => {
  // Drop the owner's cache so a non-selected head goes stale-free on next
  // hover. info.scheduleRefresh then coalesces any UI refresh for the
  // currently-selected head across bursty events.
  info.invalidateSessionCache(rail.userHeadId(msg.github_login));
  rail.refreshSoon();
  info.scheduleRefresh(msg.session_id);
  broadcastToMain("ws:sessionUpdated", msg);
});
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
  broadcast(channel, payload, getMainWindow());
}

// Tray popup (statusbar renderer) is the primary consumer of orgs:* /
// repos:* push channels. We still broadcast to main so any future settings
// UI on the main window stays in sync without extra plumbing.
function broadcastToTrayAndMain(channel: string, payload: unknown): void {
  broadcast(channel, payload, getMainWindow(), getTrayPopup());
}

backend.onChange((state) => broadcastToMain("backend:authState", state));
// Tray popup shows sign-in state too — mirror to it so the CTA flips live.
backend.onChange((state) => broadcast("backend:authState", state, getTrayPopup()));
localRepos.onChange((repos) => broadcastToTrayAndMain("backend:trackedRepos", repos));
localRepos.onSelectionChange((ids) =>
  broadcastToTrayAndMain("trackedRepos:selectionChange", [...ids]),
);
chatheadsAuth.onChange((state) => broadcastToMain("chatheads:authState", state));
githubAuth.onChange((state) => broadcastToMain("github:state", state));
anthropic.onConfiguredChange((configured) => broadcastToMain("agents:configured", configured));

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

  registerDebugShortcuts();
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
