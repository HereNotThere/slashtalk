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
import type { ChatHead } from "../shared/types";
import * as store from "./store";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as rail from "./rail";
import * as uploader from "./uploader";
import * as heartbeat from "./heartbeat";

// Single source of truth, mirrors ChatHeadWindow.swift constants.
const BUBBLE_SIZE = 48;
const SPACING = 8;
const PADDING = 22;
const OVERLAY_WIDTH = BUBBLE_SIZE + PADDING * 2;

const INFO_WIDTH = 340;
const INFO_INITIAL_HEIGHT = 80; // small placeholder; renderer reports actual on mount
const INFO_GAP = 10;

const TRAY_POPUP_WIDTH = 320;
const TRAY_POPUP_INITIAL_HEIGHT = 80;

const RESIZE_MIN = 60;
const RESIZE_MAX = 900;

// Tracked dynamically — renderer reports its content height via IPC and we
// resize/reposition the window each time it changes.
let infoCurrentHeight = INFO_INITIAL_HEIGHT;

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
    height: INFO_INITIAL_HEIGHT,
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
  const infoY = Math.round(bubbleMidY - infoCurrentHeight / 2);

  // setBounds (vs setPosition) so we apply the latest tracked height atomically.
  infoWindow.setBounds({
    x: Math.round(infoX),
    y: infoY,
    width: INFO_WIDTH,
    height: infoCurrentHeight,
  });
}

function showInfo(index: number): void {
  const head = heads[index];
  if (!head) return;

  const win = ensureInfoWindow();
  selectedHeadId = head.id;

  const send = (): void => {
    win.webContents.send("info:show", { head });
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
  }
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

ipcMain.handle("window:requestResize", (e, height: number): void => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const h = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(height)));

  if (win === infoWindow) {
    if (h === infoCurrentHeight) return;
    infoCurrentHeight = h;
    // positionInfo recenters vertically using the new tracked height.
    repositionInfoIfVisible();
    // If not currently visible, still reflect the new height so next show is correct.
    if (!selectedHeadId) {
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    }
  } else if (win === trayPopup) {
    const b = win.getBounds();
    if (h === b.height) return;
    // Tray popup is anchored at top (under the menu bar item) — height grows downward.
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  }
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
    void heartbeat.start();
  } else {
    heartbeat.stop();
    uploader.reset();
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

// Dev-only: assign stable, varied `lastActionAt` values to heads that don't
// have one, so the overlay age badge shows a mix of "now" / "Xm" / "Xh" / "Xd"
// without having to actually wait. The rail emits heads from the backend
// (which doesn't yet track per-user last-activity), so without this every
// badge would say "now". No-op in packaged builds.
function debugBackfillTimestamps(): void {
  if (app.isPackaged) return;
  const now = Date.now();
  const ages = [
    30_000,                 // "now"
    3 * 60_000,             // 3m
    17 * 60_000,            // 17m
    47 * 60_000,            // 47m
    2 * 3_600_000,          // 2h
    9 * 3_600_000,          // 9h
    23 * 3_600_000,         // 23h
    2 * 86_400_000,         // 2d
    7 * 86_400_000,         // 7d
  ];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!h || h.lastActionAt != null) continue;
    h.lastActionAt = now - ages[i % ages.length]!;
  }
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
