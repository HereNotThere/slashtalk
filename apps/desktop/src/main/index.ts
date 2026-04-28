import { app, BrowserWindow, ipcMain, globalShortcut } from "electron";
import type { ChatHead, McpTarget, ResponseOpenPayload } from "../shared/types";
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
import { configureHoverPolling } from "./windows/hover-polling";
import { appState } from "./windows/lib";
import {
  bumpActivity,
  configureRailVisibility,
  resolveRailVisibility,
} from "./windows/rail-visibility";
import { getMainWindow, showMainWindow } from "./windows/main";
import { configureResponse, showResponse } from "./windows/response";
import { createTray, getTrayPopup, toggleTrayPopup } from "./windows/tray";
import { broadcast } from "./windows/broadcast";
import { currentDock, registerDockDrag } from "./windows/dock-drag";
import * as info from "./windows/info";
import * as overlay from "./windows/overlay";
import * as spotifyToggle from "./sync/spotify-toggle";
import * as userLocation from "./sync/user-location";
import { registerWsHandlers, verifyAndMarkCollision } from "./sync/ws-handlers";
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

let heads: ChatHead[] = [];

function broadcastHeads(): void {
  broadcast(
    "heads:update",
    heads,
    overlay.getOverlayWindow(),
    getMainWindow(),
    getTrayPopup(),
    info.getInfoWindow(),
  );
}

function broadcastChatVisible(visible: boolean): void {
  broadcast("chat:state", { visible }, overlay.getOverlayWindow());
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
  overlay.applyRailPinned();
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
  getOverlay: overlay.getOverlayWindow,
  getSelectedHeadId: info.getSelectedHeadId,
  getCachedSessions: info.getCachedSessions,
  fetchSessionsForHead: info.fetchSessionsForHead,
  verifyAndMarkCollision,
});

info.registerInfo({
  getOverlay: overlay.getOverlayWindow,
  getHeads: () => heads,
});

overlay.registerOverlay();

rail.onChange((next) => {
  heads = next;
  debugBackfillTimestamps();
  // Keep the grace timestamp current while the user is working, so "15 min
  // after the last session ended" measures from the most recent live poll.
  if (rail.isSelfLive()) bumpActivity();
  if (heads.length === 0) {
    overlay.closeOverlay();
  } else {
    overlay.ensureOverlay();
    overlay.resizeOverlay();
    resolveRailVisibility();
    repositionChatIfVisible();
  }
  info.onHeadsChanged(heads);
  broadcastHeads();
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
  getOverlay: overlay.getOverlayWindow,
  effectiveOverlayLength: overlay.effectiveOverlayLength,
  onTick: () => {
    info.repositionIfVisible();
    repositionChatIfVisible();
  },
  onHideInfoNow: info.hideNow,
  onSendOverlayConfig: overlay.sendOverlayConfig,
  onSavePosition: overlay.saveOverlayPosition,
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

registerWsHandlers();

backend.onChange((state) => applySyncForAuth(state.signedIn));

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
  getOverlay: overlay.getOverlayWindow,
  getMainWindow,
  getTrayPopup,
});
configureChat({
  getOverlay: overlay.getOverlayWindow,
  getCurrentDock: currentDock,
  onVisibilityChange: broadcastChatVisible,
  resolveRailVisibility,
});
configureResponse({ onClose: hideChat });
configureHoverPolling({
  getOverlay: overlay.getOverlayWindow,
  isRailPinned: getRailPinned,
  isAppFocused: overlay.appIsFocused,
});
configureRailVisibility({
  getOverlay: overlay.getOverlayWindow,
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

app.on("did-become-active", () => {
  overlay.onAppDidBecomeActive();
});

app.on("did-resign-active", () => {
  // Re-assert regular activation policy so the app survives the transition
  // (macOS demotes us to accessory when the only visible window is a
  // normal-level NSPanel).
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    void app.dock?.show();
  }
  overlay.onAppDidResignActive();
});
