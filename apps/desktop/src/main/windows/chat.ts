// Chat input popover.
//
// Transparent window anchored on the rail's search bubble (the leading cell).
// The chat renderer paints its own pill + shadow; this module just sizes the
// frame, positions it relative to the overlay, and notifies the renderer of
// dock-anchor flips so the pill knows which side its icon should sit on.

import { BrowserWindow } from "electron";
import type { ChatAnchor, DockConfig } from "../../shared/types";
import { BUBBLE_SIZE, PADDING_Y } from "./dock-geometry";
import { loadRenderer, preloadPath } from "./lib";

const CHAT_WIDTH = 560;
const CHAT_HEIGHT = 80; // transparent window; pill + breathing room for CSS shadow
// Distance from the chat window's left edge to the center of the leading icon
// circle inside the pill — container p-sm (8) + inner pl-2 (8) + half icon (20).
// Used to align the pill's icon over the chat bubble's position. Keep in sync
// with the pill layout in renderer/chat/App.tsx.
const CHAT_ICON_OFFSET = 36;
const CHAT_GAP = 8; // distance from the rail's outer edge to the pill on horizontal docks

interface ChatDeps {
  getOverlay: () => BrowserWindow | null;
  getCurrentDock: () => DockConfig;
  /** Fires every time the chat popover shows or hides — index.ts uses it
   *  to tell the overlay renderer so the search bubble can swap state. */
  onVisibilityChange: (visible: boolean) => void;
}

let deps: ChatDeps | null = null;
let chatWindow: BrowserWindow | null = null;
let lastSentChatAnchor: ChatAnchor | null = null;

export function configureChat(d: ChatDeps): void {
  deps = d;
}

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

  // On every (re)load, the renderer's anchor state resets to its default.
  // Clear the dedup so the current anchor is re-sent even if it matches the
  // last value main observed.
  chatWindow.webContents.on("did-finish-load", () => {
    lastSentChatAnchor = null;
    sendChatConfig();
  });

  chatWindow.on("blur", () => hideChat());
  chatWindow.on("closed", () => {
    chatWindow = null;
    lastSentChatAnchor = null;
  });

  return chatWindow;
}

// Which end of the pill the search-icon circle sits at. Vertical rails extend
// inward from the screen edge. Horizontal rails have search on the leading
// (left) cell, so the pill always extends rightward from that bubble.
function chatAnchorFromDock(dock: DockConfig): ChatAnchor {
  if (dock.orientation === "horizontal") return "left";
  return dock.side === "start" ? "left" : "right";
}

function positionChat(): void {
  if (!deps) return;
  if (!chatWindow || chatWindow.isDestroyed()) return;
  const overlay = deps.getOverlay();
  if (!overlay || overlay.isDestroyed()) return;

  const stackBounds = overlay.getBounds();
  const dock = deps.getCurrentDock();
  const anchor = chatAnchorFromDock(dock);

  if (dock.orientation === "vertical") {
    // Search bubble pinned to the top of the overlay (flex-none in the
    // renderer). Anchor from window bounds so this works whether content fits
    // or the peer list is scrolling under a height cap.
    const bubbleCenterX = stackBounds.x + stackBounds.width / 2;
    const bubbleCenterY = stackBounds.y + PADDING_Y + BUBBLE_SIZE / 2;
    const chatX =
      anchor === "left"
        ? bubbleCenterX - CHAT_ICON_OFFSET
        : bubbleCenterX - (CHAT_WIDTH - CHAT_ICON_OFFSET);
    const chatY = Math.round(bubbleCenterY - CHAT_HEIGHT / 2);
    chatWindow.setBounds({
      x: Math.round(chatX),
      y: chatY,
      width: CHAT_WIDTH,
      height: CHAT_HEIGHT,
    });
    return;
  }

  // Horizontal rail: search bubble pinned to the left end of the row. Pill
  // lives on the inner side of the rail (below for top, above for bottom),
  // extending rightward from the bubble.
  const bubbleCenterX = stackBounds.x + PADDING_Y + BUBBLE_SIZE / 2;
  const chatX = bubbleCenterX - CHAT_ICON_OFFSET;
  const chatY =
    dock.side === "start"
      ? stackBounds.y + stackBounds.height + CHAT_GAP
      : stackBounds.y - CHAT_GAP - CHAT_HEIGHT;
  chatWindow.setBounds({
    x: Math.round(chatX),
    y: Math.round(chatY),
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
  });
}

export function sendChatConfig(): void {
  if (!deps) return;
  if (!chatWindow || chatWindow.isDestroyed()) return;
  const anchor = chatAnchorFromDock(deps.getCurrentDock());
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

export function showChat(): void {
  if (!deps) throw new Error("configureChat must be called before showChat");
  const win = ensureChatWindow();
  sendChatConfig();
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
  // Anchor may flip if the rail crossed the screen midline during a drag.
  sendChatConfig();
  positionChat();
}
