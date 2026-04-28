import type { BrowserWindow } from "electron";
import { nativeTheme } from "electron";
import * as store from "../store";
import { broadcast } from "./broadcast";

export type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "themeMode";

interface ThemeDeps {
  windows: () => Array<BrowserWindow | null>;
}

let deps: ThemeDeps | null = null;

export function configureTheme(d: ThemeDeps): void {
  deps = d;
}

function normalize(v: unknown): ThemeMode {
  return v === "dark" || v === "light" ? v : "system";
}

export function getThemeMode(): ThemeMode {
  return normalize(store.get<ThemeMode>(THEME_KEY));
}

export function setThemeMode(mode: ThemeMode): void {
  const next = normalize(mode);
  store.set(THEME_KEY, next);
  nativeTheme.themeSource = next;
}

export function broadcastThemeMode(): void {
  if (!deps) return;
  broadcast("theme:mode", getThemeMode(), ...deps.windows());
}

/** Apply persisted mode to nativeTheme at startup so menu-bar / native chrome
 *  match the renderer choice from the first frame. */
export function initThemeMain(): void {
  nativeTheme.themeSource = getThemeMode();
}
