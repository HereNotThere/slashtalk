// Search input pill. Mutually exclusive with the dock — takes the dock's
// lane while open. Frost + rim are painted natively (vibrancy "popover" +
// setMacCornerRadius) because CSS backdrop-filter is a no-op on non-vibrancy
// Electron windows.

import { BrowserWindow, nativeTheme, screen } from "electron";
import type { DockConfig } from "../../shared/types";
import { DOCK_EDGE_MARGIN, OVERLAY_WIDTH } from "./dock-geometry";
import { loadRenderer, preloadPath } from "./lib";
import { setMacCornerRadius } from "../macCorners";

const CHAT_WIDTH = 560;
// Match the dock's cross-axis thickness so the pill reads as a stretched
// dock segment when the search opens.
const CHAT_HEIGHT = OVERLAY_WIDTH;

interface ChatDeps {
  getOverlay: () => BrowserWindow | null;
  getCurrentDock: () => DockConfig;
  /** Fires every time the chat popover shows or hides — index.ts uses it
   *  to tell the overlay renderer so the search bubble can swap state. */
  onVisibilityChange: (visible: boolean) => void;
  /** Re-evaluate dock visibility (pinned / session-only). Called after the
   *  pill hides so the dock reappears under whichever rule applies. */
  resolveRailVisibility: () => void;
}

let deps: ChatDeps | null = null;
let chatWindow: BrowserWindow | null = null;

export function configureChat(d: ChatDeps): void {
  deps = d;
}

// Module-level listener: re-applied to whichever chatWindow exists when the
// system theme flips. Registered once so re-creating the window doesn't leak
// listeners.
nativeTheme.on("updated", () => applyChatRim());

export function isChatVisible(): boolean {
  return !!chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible();
}

function applyChatRim(): void {
  if (!chatWindow || chatWindow.isDestroyed()) return;
  setMacCornerRadius(chatWindow, CHAT_HEIGHT / 2, {
    width: 1.5,
    white: 1,
    alpha: nativeTheme.shouldUseDarkColors ? 0.12 : 0.33,
  });
}

function ensureChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow;

  chatWindow = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    frame: false,
    // `popover` is theme-adaptive (bright in light, dark in dark) — unlike
    // the dock's `hud` which is always dark.
    transparent: false,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    vibrancy: "popover",
    visualEffectState: "active",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  chatWindow.setAlwaysOnTop(true, "floating");
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  applyChatRim();

  loadRenderer(chatWindow, "chat");

  chatWindow.on("blur", () => hideChat());
  chatWindow.on("closed", () => {
    chatWindow = null;
  });

  return chatWindow;
}

function positionChat(): void {
  if (!deps) return;
  if (!chatWindow || chatWindow.isDestroyed()) return;
  const overlay = deps.getOverlay();
  if (!overlay || overlay.isDestroyed()) return;

  // Center on the work area's main axis rather than the dock's window
  // bounds, so a user-nudged dock position doesn't off-center the pill.
  const display = screen.getDisplayMatching(overlay.getBounds());
  const wa = display.workArea;
  const dock = deps.getCurrentDock();

  if (dock.orientation === "vertical") {
    const x =
      dock.side === "start"
        ? wa.x + DOCK_EDGE_MARGIN
        : wa.x + wa.width - DOCK_EDGE_MARGIN - CHAT_WIDTH;
    const y = wa.y + Math.floor((wa.height - CHAT_HEIGHT) / 2);
    chatWindow.setBounds({
      x: Math.round(x),
      y,
      width: CHAT_WIDTH,
      height: CHAT_HEIGHT,
    });
    return;
  }

  const x = wa.x + Math.floor((wa.width - CHAT_WIDTH) / 2);
  const y =
    dock.side === "start"
      ? wa.y + DOCK_EDGE_MARGIN
      : wa.y + wa.height - DOCK_EDGE_MARGIN - CHAT_HEIGHT;
  chatWindow.setBounds({
    x,
    y: Math.round(y),
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
  });
}

export function showChat(): void {
  if (!deps) throw new Error("configureChat must be called before showChat");
  const overlay = deps.getOverlay();
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
    overlay.hide();
  }
  const win = ensureChatWindow();
  positionChat();
  win.show();
  win.focus();
  deps.onVisibilityChange(true);
}

export function hideChat(): void {
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
    chatWindow.hide();
  }
  deps?.onVisibilityChange(false);
  // Re-evaluate so session-only mode can keep the dock hidden if it should.
  deps?.resolveRailVisibility();
}

export function toggleChat(): void {
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
    hideChat();
  } else {
    showChat();
  }
}

export function repositionChatIfVisible(): void {
  if (!chatWindow || chatWindow.isDestroyed() || !chatWindow.isVisible()) return;
  positionChat();
}
