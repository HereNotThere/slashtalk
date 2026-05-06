// Errors thrown from the main process travel through `ipcRenderer.invoke` and
// arrive on the renderer with two layers of noise: Electron's "Error invoking
// remote method 'X':" wrapper and a redundant leading "Error:". `addLocalRepo`
// also encodes the failed path on the first line so we can render a heading
// like "Couldn't add <path>" above the human reason.

export type ParsedIpcError = {
  // First line of the original message if the main-process throw used the
  // `<path>\n<reason>` convention (currently just `addLocalRepo`). Null
  // otherwise — callers should fall back to message-only rendering.
  context: string | null;
  message: string;
};

export function parseIpcError(err: unknown): ParsedIpcError {
  const raw = (err instanceof Error ? err.message : String(err))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "");
  const idx = raw.indexOf("\n");
  if (idx === -1) return { context: null, message: raw };
  return { context: raw.slice(0, idx), message: raw.slice(idx + 1) };
}

// Truncate a path so it fits a one-line heading in narrow surfaces (the
// 320px tray popup). Tries progressively shorter elisions —
// `/a/b/…/last` → `/a/…/last` → `/…/last` — keeping the basename intact since
// it's the most identifying segment. Falls back to a middle-character cut
// when even `/…/last` is still too long (pathologically long basenames).
export function truncatePath(p: string, max = 22): string {
  if (p.length <= max) return p;
  const segments = p.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    for (let head = Math.min(2, segments.length - 1); head >= 0; head--) {
      const prefix = head === 0 ? "" : `/${segments.slice(0, head).join("/")}`;
      const elided = `${prefix}/…/${last}`;
      if (elided.length <= max) return elided;
    }
  }
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${p.slice(0, keep)}…${p.slice(p.length - keep)}`;
}
