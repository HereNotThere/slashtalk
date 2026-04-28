import { app, clipboard, dialog, ipcMain, shell } from "electron";
import { isSafeExternalUrl } from "../safeUrl";
import { hideTrayPopup } from "../windows/tray";
import { showMainWindow } from "../windows/main";

export function registerShellIpc(): void {
  ipcMain.handle("app:openMain", (): void => {
    showMainWindow();
    hideTrayPopup();
  });

  ipcMain.handle("app:quit", (): void => app.quit());

  ipcMain.handle("clipboard:writeText", (_e, text: string): void =>
    clipboard.writeText(text ?? ""),
  );

  ipcMain.handle("shell:openExternal", async (_e, url: string): Promise<void> => {
    if (!isSafeExternalUrl(url)) {
      console.warn(`[shell:openExternal] refusing url: ${url}`);
      return;
    }
    await shell.openExternal(url);
  });

  ipcMain.handle(
    "dialog:selectDirectory",
    async (_e, defaultPath?: string): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose working directory",
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );
}
