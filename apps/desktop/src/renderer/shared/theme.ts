export type ThemeMode = "dark" | "light" | "system";

const KEY = "chatheads.theme";

function readCache(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "dark" || v === "light" ? v : "system";
}

function writeCache(mode: ThemeMode): void {
  if (mode === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
}

export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.remove("theme-dark", "theme-light");
  if (mode === "dark") root.classList.add("theme-dark");
  else if (mode === "light") root.classList.add("theme-light");
  // mode === 'system' → no class, CSS media query takes over
}

/**
 * Apply the cached mode synchronously (no flash on cold start), then sync
 * with the main process — main is the source of truth and broadcasts
 * changes from any window. localStorage stays as a cache so the next launch
 * paints the correct palette before IPC has resolved.
 */
export function initTheme(): void {
  applyThemeMode(readCache());
  const bridge = window.chatheads?.theme;
  if (!bridge) return;
  void bridge.getMode().then((mode) => {
    if (mode !== readCache()) {
      writeCache(mode);
      applyThemeMode(mode);
    }
  });
  bridge.onModeChange((mode) => {
    writeCache(mode);
    applyThemeMode(mode);
  });
}
