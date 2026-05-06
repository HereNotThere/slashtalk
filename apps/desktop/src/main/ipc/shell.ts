import { app, clipboard, dialog, ipcMain, shell } from "electron";
import { fetchGithubClientId } from "../backend";
import { githubClientId } from "../config";
import { isSafeExternalUrl } from "../safeUrl";
import { openTrayPopup } from "../windows/tray";

export function registerShellIpc(): void {
  // The tray popup is the one and only settings UI. In-app surfaces (the
  // "add a repo" rail bubble, the post-onboarding reveal) call this so they
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

  // Sends the user to GitHub's authorized-OAuth-apps page for slashtalk,
  // where they can grant or request org access. Used by the no_access error
  // UI — without OAuth approval for an org, claim attempts on its repos
  // 403 even when the user is a member. Prefers the build-time baked
  // client ID; falls back to the server (whose `GITHUB_CLIENT_ID` is the
  // canonical source) so dev environments without the env var still work.
  ipcMain.handle("shell:openGithubOAuthAppSettings", async (): Promise<void> => {
    let clientId = githubClientId();
    if (!clientId) {
      clientId = (await fetchGithubClientId()) ?? "";
    }
    if (!clientId) {
      console.warn("[shell:openGithubOAuthAppSettings] no GitHub client ID available");
      return;
    }
    await shell.openExternal(`https://github.com/settings/connections/applications/${clientId}`);
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
