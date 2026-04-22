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
import { randomUUID } from "node:crypto";
import type { ChatHead, NewChatHead } from "../shared/types";
import * as store from "./store";
import * as github from "./github";

// Single source of truth, mirrors ChatHeadWindow.swift constants.
const BUBBLE_SIZE = 48;
const SPACING = 8;
const PADDING = 22;
const OVERLAY_WIDTH = BUBBLE_SIZE + PADDING * 2;

const INFO_WIDTH = 340;
const INFO_HEIGHT = 260;
const INFO_GAP = 10;

const TRAY_POPUP_WIDTH = 320;
const TRAY_POPUP_HEIGHT = 420;

const HEADS_KEY = "heads";
const POSITION_KEY = "overlayPosition";

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let infoWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayPopup: BrowserWindow | null = null;

let heads: ChatHead[] = [];
let selectedHeadId: string | null = null;

let dragOffset: { dx: number; dy: number } | null = null;
let dragTicker: ReturnType<typeof setInterval> | null = null;

// electron-vite sets ELECTRON_RENDERER_URL in dev mode (pointing at the Vite
// dev server) so we can reuse the same BrowserWindow code for dev + packaged.
function loadRenderer(
  win: BrowserWindow,
  entry: "main" | "overlay" | "info" | "statusbar",
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

function overlayHeight(count: number): number {
  const n = Math.max(count, 1);
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
    height: INFO_HEIGHT,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
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
  infoWindow.setIgnoreMouseEvents(true);

  loadRenderer(infoWindow, "info");

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
  const bubbleMidY = stackBounds.y + PADDING + index * cell + BUBBLE_SIZE / 2;
  const infoY = Math.round(bubbleMidY - INFO_HEIGHT / 2);

  infoWindow.setPosition(Math.round(infoX), infoY);
}

function showInfo(index: number): void {
  const head = heads[index];
  if (!head) return;

  const win = ensureInfoWindow();
  selectedHeadId = head.id;

  const send = (): void => {
    win.webContents.send("info:show", { label: head.label });
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }

  positionInfo(index);
  win.showInactive();
}

function hideInfo(): void {
  selectedHeadId = null;
  if (infoWindow && !infoWindow.isDestroyed()) infoWindow.hide();
}

function repositionInfoIfVisible(): void {
  if (!selectedHeadId) return;
  const idx = heads.findIndex((h) => h.id === selectedHeadId);
  if (idx === -1) return;
  positionInfo(idx);
}

// -------- Tray + popup --------

function ensureTrayPopup(): BrowserWindow {
  if (trayPopup && !trayPopup.isDestroyed()) return trayPopup;

  trayPopup = new BrowserWindow({
    width: TRAY_POPUP_WIDTH,
    height: TRAY_POPUP_HEIGHT,
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
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("💬");
  tray.setToolTip("ChatHeads");
  tray.on("click", (_e, bounds) => toggleTrayPopup(bounds));
  tray.on("right-click", (_e, bounds) => toggleTrayPopup(bounds));
}

// -------- IPC --------

function persistHeads(): void {
  store.set(HEADS_KEY, heads);
}

ipcMain.handle("heads:spawn", (_e, head: NewChatHead): ChatHead => {
  const withId: ChatHead = { id: randomUUID(), ...head };
  heads.push(withId);
  persistHeads();
  ensureOverlay();
  resizeOverlay();
  broadcastHeads();
  return withId;
});

ipcMain.handle("heads:close", (_e, id: string): void => {
  const idx = heads.findIndex((h) => h.id === id);
  if (idx === -1) return;
  if (selectedHeadId === id) hideInfo();
  heads.splice(idx, 1);
  persistHeads();
  if (heads.length === 0) {
    overlayWindow?.close();
    overlayWindow = null;
  } else {
    resizeOverlay();
    repositionInfoIfVisible();
  }
  broadcastHeads();
});

ipcMain.handle("heads:list", (): ChatHead[] => heads);

ipcMain.handle("heads:closeAll", (): void => {
  heads = [];
  selectedHeadId = null;
  hideInfo();
  overlayWindow?.close();
  overlayWindow = null;
  persistHeads();
  broadcastHeads();
});

ipcMain.handle("heads:toggleInfo", (_e, index: number): void => {
  const head = heads[index];
  if (!head) return;
  if (selectedHeadId === head.id) hideInfo();
  else showInfo(index);
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

// GitHub
ipcMain.handle("github:getState", () => github.getState());
ipcMain.handle("github:startDeviceFlow", () => github.startDeviceFlow());
ipcMain.handle("github:cancelDeviceFlow", () => github.cancelDeviceFlow());
ipcMain.handle("github:signOut", () => github.signOut());
ipcMain.handle("github:listOrgs", () => github.listOrgs());
ipcMain.handle("github:listMembers", (_e, org: string) =>
  github.listMembers(org),
);

github.onChange((payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("github:state", payload);
  }
});

// -------- Lifecycle --------

function restoreHeads(): void {
  const saved = store.get<ChatHead[]>(HEADS_KEY);
  if (Array.isArray(saved) && saved.length > 0) {
    heads = saved;
    ensureOverlay();
    resizeOverlay();
    broadcastHeads();
  }
}

app.whenReady().then(() => {
  github.restore();
  createMainWindow();
  createTray();
  restoreHeads();
});

// Keep the app alive when all windows close — the mere presence of a
// subscriber that doesn't call app.quit() suppresses the default quit.
// Mirrors applicationShouldTerminateAfterLastWindowClosed = false.
app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else mainWindow.show();
});
