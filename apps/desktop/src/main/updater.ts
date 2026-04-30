import { app, dialog, ipcMain, Notification, type BrowserWindow } from "electron";
import electronUpdater, {
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import type { UpdateState } from "../shared/types";
import { broadcast } from "./windows/broadcast";
import { appState } from "./windows/lib";

const { autoUpdater } = electronUpdater;

const STARTUP_CHECK_DELAY_MS = 30_000;
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

interface UpdateDeps {
  windows: () => Array<BrowserWindow | null | undefined>;
  getPromptWindow: () => BrowserWindow | null;
}

let deps: UpdateDeps | null = null;
let registered = false;
let startupTimer: NodeJS.Timeout | null = null;
let periodicTimer: NodeJS.Timeout | null = null;
let updateVersion: string | null = null;
let promptedVersion: string | null = null;
let state: UpdateState = initialState();

function currentVersion(): string {
  return app.getVersion();
}

function initialState(): UpdateState {
  if (!app.isPackaged) {
    return {
      kind: "disabled",
      currentVersion: currentVersion(),
      reason: "Updates are only available in packaged builds.",
    };
  }
  return { kind: "idle", currentVersion: currentVersion() };
}

function setState(next: UpdateState): void {
  state = next;
  if (!deps) return;
  broadcast("updates:state", state, ...deps.windows());
}

function updateInfoVersion(info: UpdateInfo): string {
  return info.version || updateVersion || currentVersion();
}

function messageForError(error: Error, message?: string): string {
  const detail = message || error.message || String(error);
  return detail.trim() || "Update check failed.";
}

async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState(initialState());
    return state;
  }
  if (state.kind === "checking" || state.kind === "downloading") return state;

  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setState({
      kind: "error",
      currentVersion: currentVersion(),
      message: messageForError(err as Error),
      checkedAt: Date.now(),
    });
  }
  return state;
}

function installUpdate(): void {
  if (state.kind !== "downloaded") return;
  appState().isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
}

function showDownloadedNotification(version: string): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: "Slashtalk update ready",
    body: `Version ${version} is ready to install.`,
  }).show();
}

async function promptToInstall(version: string): Promise<void> {
  if (!deps || promptedVersion === version) return;
  promptedVersion = version;
  showDownloadedNotification(version);

  const parent = deps.getPromptWindow();
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: "Slashtalk update ready",
    message: "Restart Slashtalk to update?",
    detail: `Version ${version} has downloaded and is ready to install.`,
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);

  if (result.response === 0) installUpdate();
}

function registerUpdaterEvents(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    setState({ kind: "checking", currentVersion: currentVersion() });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    updateVersion = updateInfoVersion(info);
    setState({
      kind: "available",
      currentVersion: currentVersion(),
      updateVersion,
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    setState({
      kind: "downloading",
      currentVersion: currentVersion(),
      updateVersion: updateVersion ?? currentVersion(),
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
    updateVersion = updateInfoVersion(event);
    setState({
      kind: "downloaded",
      currentVersion: currentVersion(),
      updateVersion,
      releaseDate: event.releaseDate,
      releaseName: event.releaseName ?? undefined,
    });
    void promptToInstall(updateVersion);
  });

  autoUpdater.on("update-not-available", () => {
    updateVersion = null;
    setState({
      kind: "not-available",
      currentVersion: currentVersion(),
      checkedAt: Date.now(),
    });
  });

  autoUpdater.on("error", (error: Error, message?: string) => {
    setState({
      kind: "error",
      currentVersion: currentVersion(),
      message: messageForError(error, message),
      checkedAt: Date.now(),
    });
  });
}

function registerUpdaterIpc(): void {
  ipcMain.handle("updates:getState", (): UpdateState => state);
  ipcMain.handle("updates:check", () => checkForUpdates());
  ipcMain.handle("updates:install", (): void => installUpdate());
}

export function configureUpdater(nextDeps: UpdateDeps): void {
  deps = nextDeps;
  if (registered) return;
  registered = true;
  registerUpdaterEvents();
  registerUpdaterIpc();
}

export function startUpdateChecks(): void {
  if (!registered || !app.isPackaged) return;
  if (startupTimer || periodicTimer) return;

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void checkForUpdates();
  }, STARTUP_CHECK_DELAY_MS);

  periodicTimer = setInterval(() => {
    void checkForUpdates();
  }, PERIODIC_CHECK_INTERVAL_MS);
}

export function stopUpdateChecks(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}
