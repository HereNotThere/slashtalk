import { app, clipboard, dialog, ipcMain, shell } from "electron";
import { isSafeExternalUrl } from "../safeUrl";
import { hideTrayPopup, openTrayPopup } from "../windows/tray";
import { showMainWindow } from "../windows/main";

export function registerShellIpc(): void {
  ipcMain.handle("app:openMain", (): void => {
    showMainWindow();
    hideTrayPopup();
  });

  // The tray popup is the one and only settings UI. In-app surfaces (the
  // settings cog in Ask, the "add a repo" rail bubble) call this so they
  // anchor to the same popup the user gets from clicking the menubar icon.
  ipcMain.handle("app:openSettings", (): void => {
    openTrayPopup();
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
