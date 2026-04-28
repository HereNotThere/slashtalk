/**
 * Gate URLs handed to `shell.openExternal` from the renderer. Electron's
 * `openExternal` accepts any scheme (file:, javascript:, data:, custom OS
 * protocol handlers, …) and on macOS/Windows that can launch arbitrary
 * apps or expose local files. Restrict to https — the only legitimate
 * IPC caller in this app opens https://open.spotify.com/... track URLs.
 */
export function isSafeExternalUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
