export type ThemeMode = "dark" | "light" | "system";

const KEY = "chatheads.theme";

export function getThemeMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "dark" || v === "light" ? v : "system";
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  applyThemeMode(mode);
}

export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.remove("theme-dark", "theme-light");
  if (mode === "dark") root.classList.add("theme-dark");
  else if (mode === "light") root.classList.add("theme-light");
  // mode === 'system' → no class, CSS media query takes over
}

/** Call once at renderer startup. */
export function initTheme(): void {
  applyThemeMode(getThemeMode());
}
