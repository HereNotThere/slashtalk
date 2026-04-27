import { app, BrowserWindow } from "electron";
import path from "node:path";

type RendererEntry = "main" | "overlay" | "info" | "chat" | "response" | "statusbar";

export function appState(): typeof app & { isQuitting?: boolean } {
  return app as typeof app & { isQuitting?: boolean };
}

export const preloadPath = path.join(__dirname, "../preload/index.cjs");

export function loadRenderer(win: BrowserWindow, entry: RendererEntry): void {
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServer) {
    void win.loadURL(`${devServer}/${entry}/index.html`);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${entry}/index.html`));
  }
}
