import { BrowserWindow } from "electron";
import { appState, loadRenderer, preloadPath } from "./lib";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function createMainWindow(): BrowserWindow {
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
  // Hide-on-close rather than destroy. Rationale: the rail overlay is
  // `focusable: false`, which Electron implements as NSPanel on macOS. An
  // app whose only windows are NSPanels drops out of Cmd+Tab and the Dock's
  // "Show All Windows". Keeping a hidden regular NSWindow around guarantees
  // Slashtalk stays in the app switcher. Activating the app (dock/Cmd+Tab)
  // shows it again.
  mainWindow.on("close", (e) => {
    if (!appState().isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

/** Show the main window, creating it if needed; bring to focus if already open. */
export function showMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return createMainWindow();
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}
