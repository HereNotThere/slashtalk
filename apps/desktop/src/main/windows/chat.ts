// Search input pill.
//
// A frosted, theme-adaptive pill that takes the dock's lane while it's open
// — the dock and the pill are mutually exclusive. The BrowserWindow paints
// the frost and rim natively (vibrancy "popover" + setMacCornerRadius); the
// renderer is just transparent content laid over that material.

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
    // `transparent: false` + `vibrancy: "popover"` matches the dock's frost
    // approach but theme-adaptive (bright in light mode, dark in dark mode).
    // CSS backdrop-filter is a no-op on non-vibrancy Electron windows, so we
    // lean on NSVisualEffectView and clip it to a pill via setMacCornerRadius.
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
  nativeTheme.on("updated", applyChatRim);

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

  // The dock is hidden while chat is up, so the pill takes its lane: same
  // edge anchor + same DOCK_EDGE_MARGIN, but centered along the dock's main
  // axis instead of tracking the (possibly nudged) dock position.
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
  // Mutually exclusive with the dock — hide it first so the pill replaces it
  // visually. resolveRailVisibility() restores the dock on hide.
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
  // Restore the dock per the current rules (pinned / session-only) — it might
  // legitimately stay hidden if session-only mode says so.
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
