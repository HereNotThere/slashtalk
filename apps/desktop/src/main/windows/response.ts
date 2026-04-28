import { BrowserWindow, nativeTheme } from "electron";
import type { ResponseOpenPayload } from "../../shared/types";
import { loadRenderer, preloadPath } from "./lib";

let responseWindow: BrowserWindow | null = null;
let onClose: (() => void) | null = null;

export function getResponseWindow(): BrowserWindow | null {
  return responseWindow;
}

export function configureResponse(opts: { onClose: () => void }): void {
  onClose = opts.onClose;
}

// Match `--color-surface-2` per theme so the OS-painted frame before the
// first React paint matches the renderer's background — no light/dark flash.
function responseBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#2c2c2c" : "#ffffff";
}

nativeTheme.on("updated", () => {
  if (!responseWindow || responseWindow.isDestroyed()) return;
  responseWindow.setBackgroundColor(responseBackgroundColor());
});

function ensureResponseWindow(): BrowserWindow {
  if (responseWindow && !responseWindow.isDestroyed()) return responseWindow;

  responseWindow = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 440,
    minHeight: 360,
    frame: true,
    transparent: false,
    backgroundColor: responseBackgroundColor(),
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
    onClose?.();
  });

  return responseWindow;
}

export function showResponse(payload?: ResponseOpenPayload): void {
  // First open creates the window with `show: false`. Calling show() before
  // the renderer has painted produces a one-frame white flash; defer to
  // `ready-to-show` instead. Subsequent opens (already painted) show immediately.
  const isFirstOpen = !responseWindow || responseWindow.isDestroyed();
  const win = ensureResponseWindow();
  if (payload) {
    const send = (): void => {
      if (win.isDestroyed()) return;
      win.webContents.send("response:open", payload);
    };
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", send);
    } else {
      send();
    }
  }
  const present = (): void => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  };
  if (isFirstOpen) {
    win.once("ready-to-show", present);
  } else {
    present();
  }
}
