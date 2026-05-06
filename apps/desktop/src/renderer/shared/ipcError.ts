// Errors thrown from the main process travel through `ipcRenderer.invoke` and
// arrive on the renderer with two layers of noise: Electron's "Error invoking
// remote method 'X':" wrapper and a redundant leading "Error:". `addLocalRepo`
// also encodes the failed path on the first line so we can render a heading
// like "Couldn't add <path>" above the human reason.

import { ACTION_LINE_REGEX, type IpcErrorAction } from "../../shared/ipcAction";

export type { IpcErrorAction };

export type ParsedIpcError = {
  context: string | null;
  message: string;
  action: IpcErrorAction | null;
};

export function parseIpcError(err: unknown): ParsedIpcError {
  const raw = (err instanceof Error ? err.message : String(err))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "");
  const lines = raw.split("\n");
  let action: IpcErrorAction | null = null;
  const lastMatch = lines[lines.length - 1]?.match(ACTION_LINE_REGEX);
  if (lastMatch) {
    action = lastMatch[1] as IpcErrorAction;
    lines.pop();
  }
  if (lines.length <= 1) {
    return { context: null, message: lines.join("\n"), action };
  }
  return { context: lines[0], message: lines.slice(1).join("\n"), action };
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
