import { BrowserWindow, Tray, nativeImage, screen } from "electron";
import path from "node:path";
import { loadRenderer, preloadPath, rendererWebPreferences } from "./lib";

const TRAY_POPUP_WIDTH = 320;
// Start tall enough to fit the signed-in popup with all toggles before the
// renderer's auto-resize fires. On macOS, frameless windows created at small
// heights can occasionally refuse to grow via programmatic setBounds, so
// erring large + letting the renderer shrink down is the safer default.
const TRAY_POPUP_INITIAL_HEIGHT = 560;

let tray: Tray | null = null;
let trayPopup: BrowserWindow | null = null;

export function getTrayPopup(): BrowserWindow | null {
  return trayPopup;
}

function ensureTrayPopup(): BrowserWindow {
  if (trayPopup && !trayPopup.isDestroyed()) return trayPopup;

  trayPopup = new BrowserWindow({
    width: TRAY_POPUP_WIDTH,
    height: TRAY_POPUP_INITIAL_HEIGHT,
    frame: false,
    // Keep programmatic resize working — `resizable: false` blocks the
    // renderer's auto-resize on some macOS versions. The window is frameless
    // so the user has no drag handle either way.
    resizable: true,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: true,
    vibrancy: "popover",
    visualEffectState: "active",
    webPreferences: rendererWebPreferences({
      preload: preloadPath,
    }),
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

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - TRAY_POPUP_WIDTH / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 6);

  const clampedX = Math.max(
    screenFrame.x + 4,
    Math.min(x, screenFrame.x + screenFrame.width - TRAY_POPUP_WIDTH - 4),
  );
  win.setPosition(clampedX, y);
}

export function toggleTrayPopup(bounds: Electron.Rectangle): void {
  const win = ensureTrayPopup();
  if (win.isVisible()) {
    hideTrayPopup();
  } else {
    positionTrayPopup(bounds);
    win.show();
    win.focus();
  }
}

/** Show the tray popup anchored to the menubar tray icon. Used when an
 *  in-app surface (settings cog, "add a repo" CTA) wants to surface the
 *  same popup the user gets from clicking the tray icon — there's only one
 *  settings UI now, so all roads lead here. No-op if the tray isn't ready. */
export function openTrayPopup(): void {
  if (!tray) return;
  const win = ensureTrayPopup();
  if (win.isVisible()) {
    win.focus();
    return;
  }
  positionTrayPopup(tray.getBounds());
  win.show();
  win.focus();
}

export function hideTrayPopup(): void {
  if (trayPopup && !trayPopup.isDestroyed() && trayPopup.isVisible()) trayPopup.hide();
}

export function createTray(opts: { onClick: (bounds: Electron.Rectangle) => void }): void {
  // resources/ lives at apps/desktop/resources/, alongside out/. __dirname is
  // out/main at runtime in both dev and packaged builds.
  const iconPath = path.join(__dirname, "../../resources/trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  // Template image: macOS auto-tints to match menu bar (dark/light, focused).
  // Only the alpha channel is used — gray values are ignored.
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip("ChatHeads");
  const fire = (_e: Electron.KeyboardEvent, bounds: Electron.Rectangle): void => {
    opts.onClick(bounds);
  };
  tray.on("click", fire);
  tray.on("right-click", fire);
}
