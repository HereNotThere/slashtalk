import { BrowserWindow } from "electron";
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
    onClose?.();
  });

  return responseWindow;
}

export function showResponse(payload: ResponseOpenPayload): void {
  const win = ensureResponseWindow();
  const send = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send("response:open", payload);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
  win.show();
  win.focus();
}
