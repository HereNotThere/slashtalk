import {
  app,
  BrowserWindow,
  Tray,
  nativeImage,
  ipcMain,
  screen,
  clipboard,
  shell,
} from "electron";
import path from "node:path";
import type { ChatHead, InfoSession } from "../shared/types";
import * as store from "./store";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as rail from "./rail";
import * as uploader from "./uploader";
import * as codexUploader from "./codex-uploader";
import * as heartbeat from "./heartbeat";

// Must stay in sync with the overlay renderer's Tailwind classes:
// BUBBLE_SIZE ↔ `w-14 h-14` on Bubble/ChatBubble (56px),
// SPACING ↔ `gap-sm` on the stack (8px),
// PADDING ↔ `p-xl` on the stack (24px). Drift here = popovers misalign.
const BUBBLE_SIZE = 56;
const SPACING = 8;
const PADDING = 24;
const OVERLAY_WIDTH = BUBBLE_SIZE + PADDING * 2;

const INFO_WIDTH = 340;
const INFO_INITIAL_HEIGHT = 80; // small placeholder; renderer reports actual on mount
const INFO_GAP = 10;

const CHAT_WIDTH = 560;
const CHAT_HEIGHT = 80; // transparent window; pill + breathing room for CSS shadow
// Distance from the chat window's left edge to the center of the leading icon
// circle inside the pill — container p-sm (8) + inner pl-2 (8) + half icon (20).
// Used to align the pill's icon over the chat bubble's position. Keep in sync
// with the pill layout in renderer/chat/App.tsx.
const CHAT_ICON_OFFSET = 36;

const TRAY_POPUP_WIDTH = 320;
const TRAY_POPUP_INITIAL_HEIGHT = 80;

const RESIZE_MIN = 60;
const RESIZE_MAX = 900;

// Tracked dynamically — renderer reports its content height via IPC and we
// resize/reposition the window each time it changes.
let infoCurrentHeight = INFO_INITIAL_HEIGHT;

// When set, the info window is waiting to be shown at the index below. The
// next `window:requestResize` from the info renderer (i.e. first measurement
// after the new head/sessions are painted) triggers the actual show with the
// correct height. A fallback timeout shows it even if resize never fires.
let pendingInfoShowIndex: number | null = null;
let pendingInfoShowTimeout: NodeJS.Timeout | null = null;

const POSITION_KEY = "overlayPosition";

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let infoWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let responseWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayPopup: BrowserWindow | null = null;

let heads: ChatHead[] = [];
let selectedHeadId: string | null = null;
let sessionCache = new Map<string, InfoSession[]>();


let dragOffset: { dx: number; dy: number } | null = null;
let dragTicker: ReturnType<typeof setInterval> | null = null;

// electron-vite sets ELECTRON_RENDERER_URL in dev mode (pointing at the Vite
// dev server) so we can reuse the same BrowserWindow code for dev + packaged.
function loadRenderer(
  win: BrowserWindow,
  entry: "main" | "overlay" | "info" | "chat" | "response" | "statusbar",
): void {
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServer) {
    void win.loadURL(`${devServer}/${entry}/index.html`);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${entry}/index.html`));
  }
}

// Preload is built as CJS (.cjs) by electron.vite.config.ts — see note there.
const preloadPath = path.join(__dirname, "../preload/index.cjs");

// -------- Main (config) window --------

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 640,
    title: "ChatHeads",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });
  loadRenderer(mainWindow, "main");
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// -------- Overlay (bubbles) --------

// Overlay always renders heads plus the chat bubble at the bottom, so add 1.
function overlayHeight(count: number): number {
  const n = count + 1;
  return n * BUBBLE_SIZE + Math.max(n - 1, 0) * SPACING + PADDING * 2;
}

interface SavedPosition {
  screenId: string;
  xPercent: number;
  topPercent: number;
}

function screenIdOf(display: Electron.Display): string {
  return String(display.id ?? `${display.bounds.x},${display.bounds.y}`);
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

function ensureOverlay(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const height = overlayHeight(heads.length);
  const restored = restoredOrigin();

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height,
    x: restored?.x ?? workArea.x + workArea.width - OVERLAY_WIDTH - 24,
    y: restored?.y ?? workArea.y + Math.floor((workArea.height - height) / 2),
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false, // we drive drag manually via IPC + setPosition
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadRenderer(overlayWindow, "overlay");

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    hideInfo();
    hideChat();
  });

  return overlayWindow;
}

function resizeOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const height = overlayHeight(heads.length);
  const bounds = overlayWindow.getBounds();
  overlayWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: OVERLAY_WIDTH,
    height,
  });
}

function broadcastHeads(): void {
  const targets = [overlayWindow, mainWindow, trayPopup].filter(
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

  loadRenderer(infoWindow, "info");

  infoWindow.on("blur", () => {
    if (infoWindow && !infoWindow.isDestroyed()) infoWindow.hide();
  });
  infoWindow.on("closed", () => {
    infoWindow = null;
  });

  return infoWindow;
}

function positionInfo(index: number): void {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const stackBounds = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(stackBounds);
  const screenFrame = display.workArea;

  const stackMidX = stackBounds.x + stackBounds.width / 2;
  const screenMidX = screenFrame.x + screenFrame.width / 2;
  const alignRight = stackMidX < screenMidX;

  const visualRight = stackBounds.x + stackBounds.width - PADDING;
  const visualLeft = stackBounds.x + PADDING;
  const infoX = alignRight
    ? visualRight + INFO_GAP
    : visualLeft - INFO_GAP - INFO_WIDTH;

  const cell = BUBBLE_SIZE + SPACING;
  const avatarTopY = stackBounds.y + PADDING + index * cell;
  const infoY = Math.round(avatarTopY - 16);

  // setBounds (vs setPosition) so we apply the latest tracked height atomically.
  infoWindow.setBounds({
    x: Math.round(infoX),
    y: infoY,
    width: INFO_WIDTH,
    height: infoCurrentHeight,
  });
}

async function showInfo(index: number): Promise<void> {
  const head = heads[index];
  if (!head) return;

  const win = ensureInfoWindow();
  selectedHeadId = head.id;

  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      win.webContents.once("did-finish-load", () => resolve());
    });
  }

  // Prefetch so the renderer paints at its final size on first render. Hover
  // preloads usually warm the cache already, so this is typically a no-op.
  const sessions = await fetchSessionsForHead(head.id);

  // A newer toggle/hide might have fired while we were awaiting — bail if the
  // selected head no longer matches.
  if (selectedHeadId !== head.id) return;

  pendingInfoShowIndex = index;
  if (pendingInfoShowTimeout) clearTimeout(pendingInfoShowTimeout);
  pendingInfoShowTimeout = setTimeout(() => {
    if (pendingInfoShowIndex !== null) flushPendingInfoShow();
  }, 250);

  win.webContents.send("info:show", { head, sessions });
}

function flushPendingInfoShow(): void {
  if (pendingInfoShowIndex === null) return;
  if (!infoWindow || infoWindow.isDestroyed()) return;
  const idx = pendingInfoShowIndex;
  pendingInfoShowIndex = null;
  if (pendingInfoShowTimeout) {
    clearTimeout(pendingInfoShowTimeout);
    pendingInfoShowTimeout = null;
  }
  positionInfo(idx);
  infoWindow.show();
  infoWindow.focus();
}

function hideInfo(): void {
  selectedHeadId = null;
  pendingInfoShowIndex = null;
  if (pendingInfoShowTimeout) {
    clearTimeout(pendingInfoShowTimeout);
    pendingInfoShowTimeout = null;
  }
  if (infoWindow && !infoWindow.isDestroyed()) {
    // Renderer pauses its session poll when it sees an empty head.
    infoWindow.webContents.send("info:hide");
    infoWindow.hide();
  }
}

function repositionInfoIfVisible(): void {
  if (!selectedHeadId) return;
  const idx = heads.findIndex((h) => h.id === selectedHeadId);
  if (idx === -1) return;
  positionInfo(idx);
}

// -------- Chat input popover --------
//
// Transparent window anchored on the chat bubble (the last cell in the rail).
// The chat renderer paints its own pill + shadow; we just size + position the
// frame.

let lastSentChatAnchor: "left" | "right" | null = null;

function ensureChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow;

  chatWindow = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  chatWindow.setAlwaysOnTop(true, "floating");
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadRenderer(chatWindow, "chat");

  chatWindow.on("blur", () => hideChat());
  chatWindow.on("closed", () => {
    chatWindow = null;
  });

  return chatWindow;
}

// Which side of the pill the leading search-icon circle sits on. Determined by
// overlay position: rail on left half → pill extends right, icon on left side
// of pill. Rail on right half → mirror so the pill extends inward.
type ChatAnchor = "left" | "right";

function chatAnchorFromOverlay(): ChatAnchor {
  if (!overlayWindow || overlayWindow.isDestroyed()) return "left";
  const stackBounds = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(stackBounds);
  const screenMidX = display.workArea.x + display.workArea.width / 2;
  const stackMidX = stackBounds.x + stackBounds.width / 2;
  return stackMidX < screenMidX ? "left" : "right";
}

function positionChat(): void {
  if (!chatWindow || chatWindow.isDestroyed()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const stackBounds = overlayWindow.getBounds();
  const anchor = chatAnchorFromOverlay();

  // Chat bubble sits at the last rail cell — index === heads.length. Its center
  // on screen is the target we align the pill's leading icon to.
  const bubbleCenterX = stackBounds.x + stackBounds.width / 2;
  const cell = BUBBLE_SIZE + SPACING;
  const bubbleCenterY =
    stackBounds.y + PADDING + heads.length * cell + BUBBLE_SIZE / 2;

  const chatX =
    anchor === "left"
      ? bubbleCenterX - CHAT_ICON_OFFSET
      : bubbleCenterX - (CHAT_WIDTH - CHAT_ICON_OFFSET);
  // Align pill top to avatar top. Chat window (80) is taller than the pill
  // (56) by 24px, split 12/12 above and below by items-center + p-sm.
  const chatY = Math.round(bubbleCenterY - CHAT_HEIGHT / 2);

  chatWindow.setBounds({
    x: Math.round(chatX),
    y: chatY,
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
  });
}

function broadcastChatVisible(visible: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send("chat:state", { visible });
}

function sendChatConfig(): void {
  if (!chatWindow || chatWindow.isDestroyed()) return;
  const anchor = chatAnchorFromOverlay();
  if (anchor === lastSentChatAnchor) return;
  lastSentChatAnchor = anchor;
  const send = (): void => {
    chatWindow?.webContents.send("chat:config", { anchor });
  };
  if (chatWindow.webContents.isLoading()) {
    chatWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function showChat(): void {
  const win = ensureChatWindow();
  sendChatConfig();
  positionChat();
  win.show();
  win.focus();
  broadcastChatVisible(true);
}

function hideChat(): void {
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
    chatWindow.hide();
  }
  broadcastChatVisible(false);
}

function toggleChat(): void {
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
    hideChat();
  } else {
    showChat();
  }
}

function repositionChatIfVisible(): void {
  if (!chatWindow || chatWindow.isDestroyed() || !chatWindow.isVisible()) return;
  // Anchor may flip if the rail crossed the screen midline during a drag.
  sendChatConfig();
  positionChat();
}

// -------- Response window --------

function ensureResponseWindow(): BrowserWindow {
  if (responseWindow && !responseWindow.isDestroyed()) return responseWindow;

  responseWindow = new BrowserWindow({
    width: 460,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    frame: true,
    transparent: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  responseWindow.setAlwaysOnTop(true, "floating");
  responseWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadRenderer(responseWindow, "response");

  responseWindow.on("closed", () => {
    responseWindow = null;
    hideChat();
  });

  return responseWindow;
}

function showResponse(message: string): void {
  const win = ensureResponseWindow();
  const send = (): void => {
    win.webContents.send("response:open", { message });
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
  win.show();
  win.focus();
}

function hideResponse(): void {
  if (responseWindow && !responseWindow.isDestroyed()) responseWindow.hide();
}

// -------- Tray + popup --------

function ensureTrayPopup(): BrowserWindow {
  if (trayPopup && !trayPopup.isDestroyed()) return trayPopup;

  trayPopup = new BrowserWindow({
    width: TRAY_POPUP_WIDTH,
    height: TRAY_POPUP_INITIAL_HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: true,
    vibrancy: "popover",
    visualEffectState: "active",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  trayPopup.setAlwaysOnTop(true, "pop-up-menu");
  trayPopup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadRenderer(trayPopup, "statusbar");

  trayPopup.on("blur", () => hideTrayPopup());
  trayPopup.on("closed", () => {
    trayPopup = null;
  });

  return trayPopup;
}

function positionTrayPopup(trayBounds: Electron.Rectangle): void {
  const win = ensureTrayPopup();
  const display = screen.getDisplayMatching(trayBounds);
  const screenFrame = display.workArea;

  const x = Math.round(
    trayBounds.x + trayBounds.width / 2 - TRAY_POPUP_WIDTH / 2,
  );
  const y = Math.round(trayBounds.y + trayBounds.height + 6);

  const clampedX = Math.max(
    screenFrame.x + 4,
    Math.min(x, screenFrame.x + screenFrame.width - TRAY_POPUP_WIDTH - 4),
  );
  win.setPosition(clampedX, y);
}

function toggleTrayPopup(bounds: Electron.Rectangle): void {
  const win = ensureTrayPopup();
  if (win.isVisible()) {
    hideTrayPopup();
  } else {
    positionTrayPopup(bounds);
    win.show();
    win.focus();
  }
}

function hideTrayPopup(): void {
  if (trayPopup && !trayPopup.isDestroyed() && trayPopup.isVisible())
    trayPopup.hide();
}

function createTray(): void {
  // resources/ lives at apps/desktop/resources/, alongside out/. __dirname is
  // out/main at runtime in both dev and packaged builds.
  const iconPath = path.join(__dirname, "../../resources/trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  // Template image: macOS auto-tints to match menu bar (dark/light, focused).
  // Only the alpha channel is used — gray values are ignored.
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip("ChatHeads");
  tray.on("click", (_e, bounds) => toggleTrayPopup(bounds));
  tray.on("right-click", (_e, bounds) => toggleTrayPopup(bounds));
}

// -------- IPC --------

ipcMain.handle("heads:list", (): ChatHead[] => heads);

ipcMain.handle("debug:railSnapshot", () => rail.getDebugSnapshot());
ipcMain.handle("debug:refreshRail", () => rail.forceRefresh());

rail.onChange((next) => {
  heads = next;
  // Drop info-window selection if the targeted head left the graph.
  if (selectedHeadId && !heads.some((h) => h.id === selectedHeadId)) {
    hideInfo();
  }
  debugBackfillTimestamps();
  if (heads.length === 0) {
    overlayWindow?.close();
    overlayWindow = null;
  } else {
    ensureOverlay();
    resizeOverlay();
    repositionInfoIfVisible();
    repositionChatIfVisible();
  }
  broadcastHeads();
});

ipcMain.handle("heads:toggleInfo", (_e, index: number): void => {
  const head = heads[index];
  if (!head) return;
  if (selectedHeadId === head.id) hideInfo();
  else void showInfo(index);
});

ipcMain.handle("info:hide", (): void => hideInfo());

ipcMain.handle("chat:toggle", (): void => toggleChat());
ipcMain.handle("chat:hide", (): void => hideChat());

ipcMain.handle("response:open", (_e, message: string): void => {
  showResponse(message);
});

ipcMain.handle("drag:start", (): void => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const win = overlayWindow.getBounds();
  dragOffset = { dx: cursor.x - win.x, dy: cursor.y - win.y };

  if (dragTicker) clearInterval(dragTicker);
  dragTicker = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !dragOffset) return;
    const p = screen.getCursorScreenPoint();
    overlayWindow.setPosition(p.x - dragOffset.dx, p.y - dragOffset.dy);
    repositionInfoIfVisible();
    repositionChatIfVisible();
  }, 16);
});

ipcMain.handle("drag:end", (): void => {
  if (dragTicker) clearInterval(dragTicker);
  dragTicker = null;
  dragOffset = null;
  saveOverlayPosition();
});

ipcMain.handle("app:openMain", (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
  hideTrayPopup();
});

ipcMain.handle("app:quit", (): void => app.quit());

ipcMain.handle("clipboard:writeText", (_e, text: string): void =>
  clipboard.writeText(text ?? ""),
);
ipcMain.handle("shell:openExternal", async (_e, url: string): Promise<void> => {
  await shell.openExternal(url);
});


ipcMain.handle("window:requestResize", (e, height: number): void => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const h = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(height)));

  if (win === infoWindow) {
    const changed = h !== infoCurrentHeight;
    if (changed) infoCurrentHeight = h;

    if (pendingInfoShowIndex !== null) {
      // First measurement after a show request — reveal with the right height.
      flushPendingInfoShow();
    } else if (changed) {
      // positionInfo recenters vertically using the new tracked height.
      repositionInfoIfVisible();
      // If not currently visible, still reflect the new height so next show is correct.
      if (!selectedHeadId) {
        const b = win.getBounds();
        win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
      }
    }
  } else if (win === trayPopup) {
    const b = win.getBounds();
    if (h === b.height) return;
    // Tray popup is anchored at top — height grows downward.
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  }
});

async function fetchSessionsForHead(headId: string): Promise<InfoSession[]> {
  const cached = sessionCache.get(headId);
  if (cached) return cached;

  const login = rail.parseUserHeadId(headId);
  if (!login) return [];
  const state = backend.getAuthState();
  if (!state.signedIn) return [];
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

ipcMain.handle("sessions:forHead", async (_e, headId: string): Promise<InfoSession[]> => {
  return fetchSessionsForHead(headId);
});

// Preload sessions for a head on hover to avoid flicker when opening info window
ipcMain.handle("sessions:preload", async (_e, headId: string): Promise<void> => {
  void fetchSessionsForHead(headId);
});

// slashtalk backend
ipcMain.handle("backend:getAuthState", () => backend.getAuthState());
ipcMain.handle("backend:signIn", () => backend.signIn());
ipcMain.handle("backend:cancelSignIn", () => backend.cancelSignIn());
ipcMain.handle("backend:signOut", async () => {
  await backend.signOut();
  localRepos.clearOnSignOut();
});

function applySyncForAuth(signedIn: boolean): void {
  if (signedIn) {
    void uploader.start();
    void codexUploader.start();
    void heartbeat.start();
  } else {
    heartbeat.stop();
    uploader.reset();
    codexUploader.reset();
  }
}

backend.onChange((state) => applySyncForAuth(state.signedIn));
ipcMain.handle("backend:listRepos", () => backend.listRepos());

ipcMain.handle("backend:listTrackedRepos", () => localRepos.list());
ipcMain.handle("backend:addLocalRepo", () => localRepos.addLocalRepo());
ipcMain.handle("backend:removeLocalRepo", (_e, repoId: number) =>
  localRepos.removeLocalRepo(repoId),
);

function broadcastToMain(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

backend.onChange((state) => broadcastToMain("backend:authState", state));
localRepos.onChange((repos) => broadcastToMain("backend:trackedRepos", repos));

// -------- Lifecycle --------

// Rail derives lastActivityAt from /api/feed sessions directly, no backfill needed.
function debugBackfillTimestamps(): void {
  // No-op; kept for reference.
}

app.whenReady().then(() => {
  backend.restore();
  localRepos.restore();
  createMainWindow();
  createTray();
  rail.start();
  applySyncForAuth(backend.getAuthState().signedIn);
});

// Keep the app alive when all windows close — the mere presence of a
// subscriber that doesn't call app.quit() suppresses the default quit.
// Mirrors applicationShouldTerminateAfterLastWindowClosed = false.
app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else mainWindow.show();
});
