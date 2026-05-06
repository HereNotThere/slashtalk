// Action hints the main process can attach to an Error so the renderer
// can offer a recovery button. Carried as a trailing `__action:<kind>__`
// line on `Error.message` because Electron IPC drops `Error.cause` and
// custom properties — only the message string survives.

export type IpcErrorAction = "no_access";

export const ACTION_LINE_REGEX = /^__action:(no_access)__$/;

export function formatActionMarker(action: IpcErrorAction): string {
  return `__action:${action}__`;
}
