import type { BrowserWindow } from "electron";

type WinSrc = BrowserWindow | null | undefined;

export function liveWindows(...wins: WinSrc[]): BrowserWindow[] {
  return wins.filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
}

// Send a payload to every live (non-destroyed) target. Null/undefined entries
// are skipped so callers can pass getters that may not yet have a window.
export function broadcast(channel: string, payload: unknown, ...targets: WinSrc[]): void {
  for (const w of liveWindows(...targets)) {
    w.webContents.send(channel, payload);
  }
}

// Send to one window once its first load completes. The renderer otherwise
// drops messages received before did-finish-load. Re-checks isDestroyed
// inside the listener so a teardown mid-load doesn't throw.
export function sendWhenLoaded(win: WinSrc, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
    return;
  }
  win.webContents.send(channel, payload);
}
