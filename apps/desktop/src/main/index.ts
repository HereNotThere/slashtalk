import { app, BrowserWindow, ipcMain, globalShortcut } from "electron";
import type { DashboardScope } from "@slashtalk/shared";
import type {
  ChatHead,
  McpInstallMode,
  McpInstallOptions,
  McpTarget,
  ResponseOpenPayload,
} from "../shared/types";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as rail from "./rail";
import * as installMcp from "./installMcp";
import * as chatheadsAuth from "./chatheadsAuth";
import * as selfSession from "./selfSession";
import { createLocalMcpProxy } from "./localMcpProxy";
import { getLocalMcpProxySecret, rotateLocalMcpProxySecret } from "./localMcpProxySecret";
import { apiBaseUrl } from "./config";
import * as anthropic from "./anthropic";
import * as githubAuth from "./githubDeviceAuth";
import * as peerPresence from "./peerPresence";
import {
  broadcastRailCollapseInactive,
  broadcastRailPinned,
  broadcastRailSessionOnlyMode,
  broadcastDashboardScope,
  broadcastShowActivityTimestamps,
  configureRailState,
  getDashboardScope,
  getRailCollapseInactive,
  getRailPinned,
  getRailSessionOnlyMode,
  getShowActivityTimestamps,
  setDashboardScope,
  setRailCollapseInactive,
  setRailPinned,
  setRailSessionOnlyMode,
  setShowActivityTimestamps,
} from "./windows/rail-state";
import {
  configureChat,
  getChatWindow,
  hideChat,
  isChatVisible,
  repositionChatIfVisible,
  toggleChat,
} from "./windows/chat";
import {
  broadcastThemeMode,
  configureTheme,
  getThemeMode,
  initThemeMain,
  setThemeMode,
  type ThemeMode,
} from "./windows/theme";
import { configureHoverPolling } from "./windows/hover-polling";
import { appState } from "./windows/lib";
import {
  bumpActivity,
  configureRailVisibility,
  resolveRailVisibility,
} from "./windows/rail-visibility";
import { getMainWindow, showMainWindow } from "./windows/main";
import { configureResponse, getResponseWindow, showResponse } from "./windows/response";
import { createTray, getTrayPopup, toggleTrayPopup } from "./windows/tray";
import { broadcast } from "./windows/broadcast";
import { currentDock, registerDockDrag } from "./windows/dock-drag";
import * as info from "./windows/info";
import * as overlay from "./windows/overlay";
import * as spotifyToggle from "./sync/spotify-toggle";
import * as userLocation from "./sync/user-location";
import { registerWsHandlers, verifyAndMarkCollision } from "./sync/ws-handlers";
import { applyInitialSync, registerAuthOrchestrator } from "./sync/auth-orchestrator";
import { registerAgents } from "./ipc/agents";
import { registerDebug, registerDebugShortcuts } from "./ipc/debug";
import { registerShellIpc } from "./ipc/shell";
import { registerChatDelegateIpc } from "./ipc/chatDelegate";

// uncaughtException leaves the process in undefined state — exit so Electron
// surfaces a crash dialog and the user gets a clean restart. A stray
// unhandledRejection (often a renderer-bound IPC failure) is recoverable, so
// log-only there.
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
  process.exit(1);
});

const mcpProxy = createLocalMcpProxy({
  getToken: backend.getApiKey,
  getProxySecret: getLocalMcpProxySecret,
  rotateProxySecret: rotateLocalMcpProxySecret,
  remoteMcpUrl: installMcp.remoteMcpUrl,
});

installMcp.configureInstaller({
  localProxySecret: getLocalMcpProxySecret,
  localProxyUrl: mcpProxy.url,
});

const RESIZE_MIN = 60;
const RESIZE_MAX = 1200;

let heads: ChatHead[] = [];
let mcpProxyReady: Promise<void> | null = null;

function startMcpProxy(): Promise<void> {
  if (mcpProxyReady) return mcpProxyReady;

  mcpProxyReady = mcpProxy.start();
  void mcpProxyReady.catch((err) => {
    mcpProxyReady = null;
    console.warn("[localMcpProxy] start failed:", err);
  });
  void mcpProxyReady
    .then(async () => {
      try {
        await installMcp.reconcileLocalProxyConfigs();
      } catch (err) {
        console.warn("[localMcpProxy] config reconcile failed:", err);
      }
    })
    .catch(() => undefined);
  return mcpProxyReady;
}

function waitForMcpProxyReady(): Promise<void> {
  return mcpProxyReady ?? startMcpProxy();
}

function parseMcpInstallMode(value: unknown): McpInstallMode | undefined {
  if (value === undefined) return undefined;
  if (value === "local-proxy" || value === "legacy-bearer") return value;
  throw new Error(`Invalid MCP install mode: ${String(value)}`);
}

function parseMcpInstallOptions(options: unknown): McpInstallOptions | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid MCP install options");
  }
  return { mode: parseMcpInstallMode((options as Record<string, unknown>).mode) };
}

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

async function broadcastMcpStatus(): Promise<void> {
  try {
    broadcast("mcp:status", await installMcp.status(), getMainWindow(), getTrayPopup());
  } catch (err) {
    console.warn("[mcp] status broadcast failed:", err);
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

ipcMain.handle("rail:getDashboardScope", (): DashboardScope => getDashboardScope());
ipcMain.handle("rail:setDashboardScope", (_e, scope: DashboardScope): void => {
  setDashboardScope(scope);
  // Caches and currently-shown card are scope-bound — clear and refetch so
  // the user sees the new window immediately, not after the next hover.
  info.onDashboardScopeChanged();
  broadcastDashboardScope();
});

ipcMain.handle("theme:getMode", (): ThemeMode => getThemeMode());
ipcMain.handle("theme:setMode", (_e, mode: ThemeMode): void => {
  setThemeMode(mode);
  broadcastThemeMode();
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

ipcMain.handle("ask:show", (): void => {
  showResponse();
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
    return backend.askChat(messages, threadId);
  },
);

ipcMain.handle("chat:history", () => backend.fetchChatHistory());

ipcMain.handle("chat:gerund", (_e, prompt: string) => backend.fetchChatGerunds(prompt));

registerChatDelegateIpc(getResponseWindow);

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

ipcMain.handle("mcp:install", async (_e, target: McpTarget, options?: unknown) => {
  try {
    await waitForMcpProxyReady();
    return await installMcp.install(target, parseMcpInstallOptions(options));
  } finally {
    await broadcastMcpStatus();
  }
});
ipcMain.handle("mcp:uninstall", async (_e, target: McpTarget) => {
  try {
    return await installMcp.uninstall(target);
  } finally {
    await broadcastMcpStatus();
  }
});
ipcMain.handle("mcp:status", () => installMcp.status());
ipcMain.handle("mcp:url", async () => {
  await waitForMcpProxyReady();
  return installMcp.mcpUrl();
});
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

registerWsHandlers();
registerAuthOrchestrator();

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
configureTheme({
  windows: () => [
    overlay.getOverlayWindow(),
    getMainWindow(),
    getTrayPopup(),
    info.getInfoWindow(),
    getChatWindow(),
    getResponseWindow(),
  ],
});
initThemeMain();
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

app
  .whenReady()
  .then(async () => {
    console.log(`[startup] apiBaseUrl=${apiBaseUrl()}`);
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
    mcpProxy.on("port-changed", (port) => {
      console.log("[localMcpProxy] persisted port changed", { port });
    });
    startMcpProxy();
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
    applyInitialSync();

    registerDebugShortcuts();
  })
  .catch((err) => {
    console.error("[startup] app.whenReady handler failed:", err);
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
  showAskOrSettings();
});

// macOS reopen (dock click, Cmd+Tab, first launch) lands the user on a fresh
// Ask window — past threads are reachable via the in-window History drawer,
// settings via the tray. Signed-out users still see settings so they can sign in.
function showAskOrSettings(): void {
  const auth = backend.getAuthState();
  if (!auth.signedIn) {
    showMainWindow();
    return;
  }
  showResponse();
}

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
