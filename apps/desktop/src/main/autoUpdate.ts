// Auto-update via electron-updater + GitHub Releases.
//
// Behavior:
//   • Background check on launch (5s after ready) and every hour while running.
//   • Auto-download when an update is available.
//   • On `update-downloaded`, prompt the user with a native dialog: Restart now
//     (calls quitAndInstall) or Later (the update applies on next quit because
//     `autoInstallOnAppQuit` is left at its default of true).
//   • Manual check from the renderer surfaces a dialog with the result.
//
// Disabled in dev (electron-updater needs a packaged app to read app-update.yml).

import { app, dialog, ipcMain, BrowserWindow } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";

const HOURLY_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5_000;

export type AutoUpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "not-available"; version: string }
  | { kind: "error"; message: string };

let status: AutoUpdateStatus = { kind: "idle" };
let manualCheckInFlight = false;
let promptShownForVersion: string | null = null;

function setStatus(next: AutoUpdateStatus): void {
  status = next;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("update:status", next);
  }
}

function configureLogger(): void {
  // electron-updater uses electron-log by default if installed; without it we
  // wire a minimal console logger so the events show up in the main process
  // stdout for debugging.
  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log("[updater]", ...args),
    warn: (...args: unknown[]) => console.warn("[updater]", ...args),
    error: (...args: unknown[]) => console.error("[updater]", ...args),
    debug: () => {},
  };
}

function onUpdateDownloaded(info: UpdateInfo): void {
  if (promptShownForVersion === info.version) return;
  promptShownForVersion = info.version;

  void dialog
    .showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Slashtalk ${info.version} is ready to install.`,
      detail: "Restart now to apply the update, or it will install the next time you quit.",
    })
    .then((result) => {
      if (result.response === 0) {
        // isSilent=false shows the macOS "moving to Applications" UX; isForceRunAfter=true
        // relaunches after install. Defaults are sensible so we leave them.
        autoUpdater.quitAndInstall();
      }
    });
}

function attachEvents(): void {
  autoUpdater.on("checking-for-update", () => {
    setStatus({ kind: "checking" });
  });
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    setStatus({ kind: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    setStatus({ kind: "not-available", version: info.version });
    if (manualCheckInFlight) {
      manualCheckInFlight = false;
      void dialog.showMessageBox({
        type: "info",
        title: "You're up to date",
        message: `Slashtalk ${app.getVersion()} is the latest version.`,
      });
    }
  });
  autoUpdater.on("download-progress", (p: { percent: number }) => {
    const version =
      status.kind === "available" || status.kind === "downloading" ? status.version : "";
    setStatus({ kind: "downloading", percent: Math.round(p.percent), version });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    setStatus({ kind: "downloaded", version: info.version });
    onUpdateDownloaded(info);
  });
  autoUpdater.on("error", (err: Error) => {
    const message = err?.message ?? String(err);
    setStatus({ kind: "error", message });
    if (manualCheckInFlight) {
      manualCheckInFlight = false;
      void dialog.showMessageBox({
        type: "error",
        title: "Update check failed",
        message: "Could not check for updates.",
        detail: message,
      });
    }
  });
}

async function safeCheck(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn("[updater] checkForUpdates threw:", err);
  }
}

export async function checkForUpdatesManually(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: "info",
      title: "Updates disabled",
      message: "Auto-update is only available in packaged builds.",
    });
    return;
  }
  if (manualCheckInFlight) return;
  manualCheckInFlight = true;
  await safeCheck();
  // If the check resolved synchronously to update-available, the prompt arrives
  // via update-downloaded later. Clear the manual flag so the next not-available
  // / error event doesn't double-prompt.
  if (status.kind === "available" || status.kind === "downloading") {
    manualCheckInFlight = false;
  }
}

export function getAutoUpdateStatus(): AutoUpdateStatus {
  return status;
}

export function init(): void {
  configureLogger();
  attachEvents();

  ipcMain.handle("update:check", () => checkForUpdatesManually());
  ipcMain.handle("update:status", (): AutoUpdateStatus => status);
  ipcMain.handle("update:installNow", (): void => {
    if (status.kind === "downloaded") autoUpdater.quitAndInstall();
  });

  if (!app.isPackaged) {
    console.log("[updater] dev build — auto-update disabled");
    return;
  }

  // Slight delay so the initial check doesn't race with window creation /
  // backend restore. Avoids flashing "checking…" before the UI is ready.
  setTimeout(() => void safeCheck(), STARTUP_DELAY_MS);
  setInterval(() => void safeCheck(), HOURLY_MS);
}
