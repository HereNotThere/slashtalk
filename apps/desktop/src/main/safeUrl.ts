/**
 * Gate URLs handed to `shell.openExternal` from the renderer. Electron's
 * `openExternal` accepts any scheme (file:, javascript:, data:, custom OS
 * protocol handlers, …) and on macOS/Windows that can launch arbitrary
 * apps or expose local files. Restrict to https (Spotify track URLs, GitHub
 * PRs) and mailto (feedback link).
 */
const ALLOWED_PROTOCOLS = new Set(["https:", "mailto:"]);

export function isSafeExternalUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
