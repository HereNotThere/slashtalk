import {
  app,
  BrowserWindow,
  Tray,
  nativeImage,
  ipcMain,
  screen,
  clipboard,
  shell,
  dialog,
  globalShortcut,
} from "electron";
import path from "node:path";
import type {
  AgentHistoryPage,
  AgentSessionSummary,
  AgentStreamEvent,
  AgentSummary,
  ChatHead,
  CreateAgentInput,
  InfoSession,
  McpTarget,
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
import * as anthropic from "./anthropic";
import * as localAgent from "./localAgent";
import * as agentStore from "./agentStore";
import * as agentIngest from "./agentIngest";
import * as summarize from "./summarize";
import * as githubAuth from "./githubDeviceAuth";
import type { LocalAgent } from "./agentStore";
import { setMacCornerRadius } from "./macCorners";

// Must stay in sync with the overlay renderer's Tailwind classes:
// BUBBLE_SIZE ↔ `w-[45px] h-[45px]` on Bubble/ChatBubble (45px),
// SPACING ↔ `gap-[14px]` on the stack (14px),
// PADDING_X ↔ `px-md` on the stack (12px),
// PADDING_Y ↔ `py-lg` on the stack (16px). Drift here = popovers misalign.
const BUBBLE_SIZE = 45;
const SPACING = 14;
const PADDING_X = 12;
const PADDING_Y = 16;
const OVERLAY_WIDTH = BUBBLE_SIZE + PADDING_X * 2;

const INFO_WIDTH = 340;
const INFO_INITIAL_HEIGHT = 80; // small placeholder; renderer reports actual on mount
const INFO_GAP = 8; // distance from the pill's outer edge to the info window

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

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let infoWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let responseWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayPopup: BrowserWindow | null = null;

let heads: ChatHead[] = [];
let selectedHeadId: string | null = null;
const sessionCache = new Map<string, InfoSession[]>();

function toAgentSummary(a: LocalAgent): AgentSummary {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    model: a.model,
    createdAt: a.createdAt,
    mode: a.mode ?? "cloud",
    cwd: a.cwd,
    visibility: a.visibility ?? "private",
  };
}

function isLocalAgent(a: { mode?: "cloud" | "local" }): boolean {
  return a.mode === "local";
}

const streamingAgents = new Set<string>();

let dragOffset: { dx: number; dy: number } | null = null;
let dragTicker: ReturnType<typeof setInterval> | null = null;
// While the stack is being dragged, bubble hovers still fire (the cursor sits
// over bubbles as the window moves under it), which would pop the info card
// repeatedly. Suppress showInfo for the duration of the drag + dock animation.
let isDraggingStack = false;

// Dock-to-edge feature. During drag we show a dashed ghost at the nearest dock
// slot (center-left / center-right); on release the overlay tweens to it.
const DOCK_EDGE_MARGIN = 24;
const DOCK_ANIM_MS = 180;
let dockPlaceholderWindow: BrowserWindow | null = null;
// Monotonic counter — each new tween takes the next token; in-flight steps
// bail when they see a newer token, so a re-drag mid-slide cancels cleanly.
let overlayAnimToken = 0;

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
    title: "Slashtalk",
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
  return n * BUBBLE_SIZE + Math.max(n - 1, 0) * SPACING + PADDING_Y * 2;
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
    alwaysOnTop: true,
    resizable: false,
    movable: false, // we drive drag manually via IPC + setPosition
    skipTaskbar: true,
    backgroundColor: "#00000000",
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

  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Pill ends — half the window width gives perfect semicircle caps at top
  // and bottom. Safe to call synchronously: getNativeWindowHandle is valid
  // as soon as the BrowserWindow constructor returns.
  setMacCornerRadius(overlayWindow, OVERLAY_WIDTH / 2, {
    width: 1.5,
    white: 1,
    alpha: 0.33,
  });

  loadRenderer(overlayWindow, "overlay");

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    hideInfoNow();
    hideChat();
  });

  return overlayWindow;
}

const OVERLAY_SCREEN_MARGIN = 40;

function resizeOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(overlayWindow.getBounds());
  const maxHeight = Math.max(
    overlayHeight(0),
    display.workArea.height - OVERLAY_SCREEN_MARGIN * 2,
  );
  const height = Math.min(overlayHeight(heads.length), maxHeight);
  const bounds = overlayWindow.getBounds();
  // Keep the window inside the work area after a size change so the ask bubble
  // never clips below the dock.
  const minY = display.workArea.y + OVERLAY_SCREEN_MARGIN;
  const maxY = display.workArea.y + display.workArea.height - height - OVERLAY_SCREEN_MARGIN;
  const y = Math.max(minY, Math.min(bounds.y, maxY));
  // `animate: true` uses macOS's native NSWindow animator (~200ms ease), which
  // reads as a fluid grow/shrink alongside the renderer's bubble enter/exit
  // animations. No-op on other platforms.
  const animate = bounds.height !== height || bounds.y !== y;
  overlayWindow.setBounds(
    { x: bounds.x, y, width: OVERLAY_WIDTH, height },
    animate,
  );
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

  // No blur-hide: hover model owns visibility; a blur-triggered hide fights
  // with the leave-timer and click-outside logic.
  infoWindow.on("closed", () => {
    infoWindow = null;
  });

  return infoWindow;
}

function positionInfo(index: number, bubbleScreenY?: number): void {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const stackBounds = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(stackBounds);
  const screenFrame = display.workArea;

  const stackMidX = stackBounds.x + stackBounds.width / 2;
  const screenMidX = screenFrame.x + screenFrame.width / 2;
  const alignRight = stackMidX < screenMidX;

  const pillRight = stackBounds.x + stackBounds.width;
  const pillLeft = stackBounds.x;
  const infoX = alignRight
    ? pillRight + INFO_GAP
    : pillLeft - INFO_GAP - INFO_WIDTH;

  // Prefer the renderer-reported screen-Y when available: with a scrollable
  // peer list the index-based formula no longer reflects where the bubble
  // actually sits. Fall back to the formula for callers that don't have a
  // live DOM rect (e.g. chat-bubble reposition during resize).
  const cell = BUBBLE_SIZE + SPACING;
  const avatarTopY =
    bubbleScreenY ?? stackBounds.y + PADDING_Y + index * cell;
  const infoY = Math.round(avatarTopY - 16);

  infoWindow.setBounds({
    x: Math.round(infoX),
    y: infoY,
    width: INFO_WIDTH,
    height: infoCurrentHeight,
  });
}

async function showInfo(index: number, bubbleScreenY?: number): Promise<void> {
  if (isDraggingStack) return;
  const head = heads[index];
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
  }

  // Size the window using the cached height for this head (if we've rendered
  // it before) so first paint lands at the right size instead of mid-resize.
  const cachedHeight = infoHeightByHead.get(head.id);
  if (cachedHeight) infoCurrentHeight = cachedHeight;

  // Send cached sessions immediately if we have them; renderer handles the
  // `null` case by loading on its own effect.
  const cached = sessionCache.get(head.id) ?? null;
  win.webContents.send("info:show", { head, sessions: cached });

  // Animate position/size when switching heads on an already-visible window;
  // land-in-place on first appearance.
  const firstShow = !win.isVisible();
  positionInfo(index, bubbleScreenY);
  if (firstShow) win.showInactive();

  // Cache miss: fetch in the background and push the result to the renderer.
  // The renderer's load-effect is keyed on head.id, so a re-hover of the same
  // head after the cache was cleared (e.g. by uploader.onIngested) won't
  // re-fire it — without this push the renderer sits on "Loading…" (and any
  // expanded row is hidden) until the 15s poll ticks.
  if (!cached) {
    void fetchSessionsForHead(head.id).then((loaded) => {
      if (selectedHeadId !== head.id) return;
      if (!infoWindow || infoWindow.isDestroyed()) return;
      infoWindow.webContents.send("info:show", { head, sessions: loaded });
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
  if (infoWindow && !infoWindow.isDestroyed()) {
    infoWindow.webContents.send("info:hide");
    // Defer the actual NSWindow hide until the renderer's fade-out completes
    // so we don't clip the transition.
    if (infoHideFadeTimer) clearTimeout(infoHideFadeTimer);
    infoHideFadeTimer = setTimeout(() => {
      infoHideFadeTimer = null;
      if (
        infoWindow &&
        !infoWindow.isDestroyed() &&
        selectedHeadId === null
      ) {
        infoWindow.hide();
      }
    }, INFO_FADE_OUT_MS);
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

  // Chat bubble is pinned to the bottom of the overlay window (flex-none in
  // the renderer). Anchor from window bounds so this works whether content
  // fits or the peer list is scrolling under a height cap.
  const bubbleCenterX = stackBounds.x + stackBounds.width / 2;
  const bubbleCenterY =
    stackBounds.y + stackBounds.height - PADDING_Y - BUBBLE_SIZE / 2;

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
ipcMain.handle("debug:shuffleRail", () => rail.debugShuffleRail());
ipcMain.handle("debug:addFakeTeammate", () => rail.debugAddFakeTeammate());
ipcMain.handle("debug:removeFakeTeammate", () =>
  rail.debugRemoveFakeTeammate(),
);
ipcMain.handle("debug:replayEnterAnimation", () => replayEnterAnimation());

function replayEnterAnimation(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send("debug:replayEnter");
}

rail.onChange((next) => {
  heads = next;
  // Drop info-window selection if the targeted head left the graph.
  if (selectedHeadId && !heads.some((h) => h.id === selectedHeadId)) {
    hideInfoNow();
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
  // Pre-warm the session cache so hover-to-show is instant.
  for (const h of heads) {
    if (!sessionCache.has(h.id)) void fetchSessionsForHead(h.id);
  }
  broadcastHeads();
});

ipcMain.handle(
  "heads:showInfo",
  (_e, index: number, bubbleScreenY?: number): void => {
    const head = heads[index];
    if (!head) return;
    void showInfo(index, bubbleScreenY);
  },
);

ipcMain.handle("info:hide", (): void => scheduleHideInfo());
ipcMain.handle("info:hoverEnter", (): void => cancelHideInfo());
ipcMain.handle("info:hoverLeave", (): void => scheduleHideInfo());

ipcMain.handle("chat:toggle", (): void => toggleChat());
ipcMain.handle("chat:hide", (): void => hideChat());

ipcMain.handle("response:open", (_e, message: string): void => {
  showResponse(message);
});

// -------- Dock to edge (drag → release → snap) --------

type DockSide = "left" | "right";

function overlayDisplay(): Electron.Display {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return screen.getPrimaryDisplay();
  }
  return screen.getDisplayMatching(overlayWindow.getBounds());
}

function currentDockSide(): DockSide {
  if (!overlayWindow || overlayWindow.isDestroyed()) return "right";
  const b = overlayWindow.getBounds();
  const wa = overlayDisplay().workArea;
  const overlayCenter = b.x + b.width / 2;
  const screenCenter = wa.x + wa.width / 2;
  return overlayCenter < screenCenter ? "left" : "right";
}

function computeDockBounds(side: DockSide): Electron.Rectangle {
  const wa = overlayDisplay().workArea;
  const height = overlayHeight(heads.length);
  const x =
    side === "left"
      ? wa.x + DOCK_EDGE_MARGIN
      : wa.x + wa.width - OVERLAY_WIDTH - DOCK_EDGE_MARGIN;
  const y = wa.y + Math.floor((wa.height - height) / 2);
  return { x, y, width: OVERLAY_WIDTH, height };
}

function ensureDockPlaceholder(): BrowserWindow {
  if (dockPlaceholderWindow && !dockPlaceholderWindow.isDestroyed()) {
    return dockPlaceholderWindow;
  }
  const radius = Math.round(OVERLAY_WIDTH / 2);
  // Single-pill shape matched to the overlay. Loaded from a data URL so this
  // stays self-contained — no new renderer entry to wire through vite.
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%;}
    .pill{
      position:fixed;inset:0;box-sizing:border-box;
      border:2px dashed rgba(255,255,255,0.55);
      border-radius:${radius}px;
      background:rgba(255,255,255,0.05);
    }
  </style></head><body><div class="pill"></div></body></html>`;
  dockPlaceholderWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: overlayHeight(heads.length),
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
  void dockPlaceholderWindow.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(html),
  );
  dockPlaceholderWindow.on("closed", () => {
    dockPlaceholderWindow = null;
  });
  return dockPlaceholderWindow;
}

function updateDockPlaceholder(): void {
  const ph = ensureDockPlaceholder();
  ph.setBounds(computeDockBounds(currentDockSide()));
  if (!ph.isVisible()) ph.showInactive();
}

function hideDockPlaceholder(): void {
  if (!dockPlaceholderWindow || dockPlaceholderWindow.isDestroyed()) return;
  if (dockPlaceholderWindow.isVisible()) dockPlaceholderWindow.hide();
}

function animateOverlayTo(
  target: Electron.Rectangle,
  duration: number,
  onDone?: () => void,
): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayAnimToken += 1;
  const token = overlayAnimToken;
  const start = overlayWindow.getBounds();
  const t0 = Date.now();
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3); // easeOutCubic
  const step = (): void => {
    if (
      token !== overlayAnimToken ||
      !overlayWindow ||
      overlayWindow.isDestroyed()
    ) {
      return;
    }
    const t = Math.min(1, (Date.now() - t0) / duration);
    const e = ease(t);
    overlayWindow.setPosition(
      Math.round(start.x + (target.x - start.x) * e),
      Math.round(start.y + (target.y - start.y) * e),
    );
    repositionInfoIfVisible();
    repositionChatIfVisible();
    if (t < 1) setTimeout(step, 16);
    else onDone?.();
  };
  step();
}

ipcMain.handle("drag:start", (): void => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // A new drag cancels any in-flight dock tween.
  overlayAnimToken += 1;

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

  const target = computeDockBounds(currentDockSide());
  // Keep isDraggingStack on through the slide so bubble hovers under the
  // moving window don't pop the info card mid-tween.
  animateOverlayTo(target, DOCK_ANIM_MS, () => {
    isDraggingStack = false;
    saveOverlayPosition();
  });
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
    const { height: screenH } = screen.getDisplayMatching(win.getBounds())
      .workAreaSize;
    maxForWin = Math.min(
      INFO_MAX_ABSOLUTE,
      Math.floor(screenH * INFO_MAX_SCREEN_FRACTION),
    );
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

ipcMain.handle(
  "agentSessions:forAgent",
  async (_e, agentId: string) => agentIngest.listForAgent(agentId),
);

ipcMain.handle("mcp:install", (_e, target: McpTarget) =>
  installMcp.install(target, chatheadsAuth.getToken()),
);
ipcMain.handle("mcp:uninstall", (_e, target: McpTarget) =>
  installMcp.uninstall(target),
);
ipcMain.handle("mcp:status", () => installMcp.status());
ipcMain.handle("mcp:url", () => installMcp.mcpUrl());
ipcMain.handle("mcp:detailForHead", (_e, _headId: string) =>
  Promise.resolve(null),
);

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
ipcMain.handle(
  "agents:create",
  async (_e, input: CreateAgentInput): Promise<AgentSummary> => {
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
    };
    agentStore.add(row);
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
    cursor?: string | null,
  ): Promise<AgentHistoryPage> => {
    const row = agentStore.get(agentId);
    if (!row?.activeSessionId) return { msgs: [], nextCursor: null };
    if (isLocalAgent(row)) {
      return localAgent.loadSessionMessages(row.activeSessionId, cursor);
    }
    try {
      return await anthropic.loadSessionMessages(row.activeSessionId, cursor);
    } catch (err) {
      console.warn("history load failed:", err);
      return { msgs: [], nextCursor: null };
    }
  },
);
ipcMain.handle("agents:send", async (_e, agentId: string, text: string) => {
  const row = agentStore.get(agentId);
  if (!row) throw new Error("Unknown agent");
  streamingAgents.add(agentId);
  try {
    let sessionId = row.activeSessionId;
    if (!sessionId) {
      sessionId = isLocalAgent(row)
        ? localAgent.localSessionId()
        : (await anthropic.startSession(agentId)).sessionId;
      const createdAt = Date.now();
      agentStore.addSession(agentId, { id: sessionId, createdAt });
      agentIngest.upsertSessionStart(row, sessionId, createdAt);
      emitSessionsChange(agentId);
    }

    const session = row.sessions.find((s) => s.id === sessionId);
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
      void localAgent.sendMessage(streamSessionId, text, row, handleEvent);
    } else {
      void anthropic.sendMessage(streamSessionId, text, handleEvent);
    }
  } catch (err) {
    streamingAgents.delete(agentId);
    throw err;
  }
});
ipcMain.handle(
  "agents:listSessions",
  (_e, agentId: string): AgentSessionSummary[] => {
    const row = agentStore.get(agentId);
    if (row && !isLocalAgent(row)) void refreshSessionsFromServer(agentId);
    return row?.sessions ?? [];
  },
);

const pendingArchive = new Set<string>();
const PENDING_ARCHIVE_TTL_MS = 30_000;

async function refreshSessionsFromServer(agentId: string): Promise<void> {
  try {
    const server = await anthropic.listAgentSessions(agentId);
    const active = server.filter(
      (s) => s.archivedAt == null && !pendingArchive.has(s.id),
    );
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

ipcMain.handle(
  "agents:popOut",
  (_e, agentId: string, sessionId: string): void => {
    showResponse(`Agent ${agentId} session ${sessionId}`);
  },
);

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
    const startedAtMs =
      row?.sessions.find((s) => s.id === sessionId)?.createdAt ?? Date.now();
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
    agent_id: agent.id,
    session_id: sessionId,
    mode: "cloud" as const,
    visibility: "team" as const,
    name: agent.name,
    started_at: new Date(startedAtMs).toISOString(),
    ended_at: endedAt,
    last_activity: endedAt,
  };
  try {
    const { summary, model } = await summarize.summarizeCloudSession(sessionId);
    await agentIngest.upsertSession({
      ...base,
      summary,
      summary_model: model,
      summary_ts: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[summarize] failed:", err);
    await agentIngest.upsertSession(base);
  }
}

ipcMain.handle(
  "agents:newSession",
  async (_e, agentId: string): Promise<AgentSessionSummary> => {
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
  },
);

ipcMain.handle(
  "agents:selectSession",
  (_e, agentId: string, sessionId: string): void => {
    agentStore.setActiveSession(agentId, sessionId);
    emitSessionsChange(agentId);
  },
);

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
ipcMain.handle("chatheads:signIn", async () => {
  await chatheadsAuth.signIn();
  try {
    await installMcp.install("claude-code", chatheadsAuth.getToken());
  } catch (err) {
    console.warn("auto-install after sign-in failed:", err);
  }
});
ipcMain.handle("chatheads:cancelSignIn", () => chatheadsAuth.cancelSignIn());
ipcMain.handle("chatheads:signOut", async () => {
  await chatheadsAuth.signOut();
  await installMcp.uninstall("claude-code");
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
    ws.start();
  } else {
    heartbeat.stop();
    uploader.reset();
    ws.stop();
  }
}

ws.onPrActivity((msg) => {
  console.log(
    `[ws] pr_activity ${msg.action} by ${msg.login} on ${msg.repoFullName}#${msg.number}`,
  );
  rail.markPrActivity(msg.login);
});

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
    infoWindow.webContents.send("info:show", { head, sessions });
  } catch (e) {
    console.warn("[ws] refreshInfoNow failed:", e);
  }
}
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

function agentConsumerWindows(): BrowserWindow[] {
  return [mainWindow, infoWindow, responseWindow].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  );
}

function broadcastAgentEvent(event: AgentStreamEvent): void {
  for (const w of agentConsumerWindows()) {
    w.webContents.send("agents:event", event);
  }
}

backend.onChange((state) => broadcastToMain("backend:authState", state));
localRepos.onChange((repos) => broadcastToMain("backend:trackedRepos", repos));
chatheadsAuth.onChange((state) => broadcastToMain("chatheads:authState", state));
githubAuth.onChange((state) => broadcastToMain("github:state", state));
anthropic.onConfiguredChange((configured) =>
  broadcastToMain("agents:configured", configured),
);
agentStore.onChange((agents) =>
  broadcastToMain("agents:listChange", agents.map(toAgentSummary)),
);

// -------- Lifecycle --------

// Rail derives lastActivityAt from /api/feed sessions directly, no backfill needed.
function debugBackfillTimestamps(): void {
  // No-op; kept for reference.
}

app.whenReady().then(() => {
  backend.restore();
  chatheadsAuth.restore();
  anthropic.restore();
  githubAuth.restore();
  localRepos.restore();
  createMainWindow();
  createTray();
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
    ];
    for (const [accel, fn] of bindings) {
      const ok = globalShortcut.register(accel, fn);
      if (!ok) console.warn(`[debug] failed to register ${accel}`);
    }
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// Keep the app alive when all windows close — the mere presence of a
// subscriber that doesn't call app.quit() suppresses the default quit.
// Mirrors applicationShouldTerminateAfterLastWindowClosed = false.
app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else mainWindow.show();
});
