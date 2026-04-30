import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import * as backend from "../backend";
import * as rail from "../rail";
import type { InfoSession } from "../../shared/types";

interface DebugDeps {
  getOverlay: () => BrowserWindow | null;
  // The currently-shown popover head (if any). Used to bias collision picks
  // toward the head you're already looking at.
  getSelectedHeadId: () => string | null;
  getCachedSessions: (headId: string) => InfoSession[] | undefined;
  fetchSessionsForHead: (headId: string) => Promise<InfoSession[]>;
  // Same verifier the WS path uses — refreshes cache and stamps the ring only
  // when one of the peer's live sessions still contains the file.
  verifyAndMarkCollision: (login: string, filePath: string) => Promise<void>;
}

// Set on register. registerDebug must run before any of the IPC handlers or
// shortcut bindings can fire, so non-null access inside helpers is safe.
let deps: DebugDeps;

function replayEnterAnimation(): void {
  const overlay = deps.getOverlay();
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send("debug:replayEnter");
}

// DEV ONLY — fire a synthetic collision against a peer in the rail, picking
// a real file from one of their live sessions so the in-row banner has
// something to attach to. Both ring + popover banner are guaranteed to
// appear together (or neither does — see verifyAndMarkCollision).
async function runDebugFireCollision(): Promise<void> {
  const heads = rail.list();
  const selectedHeadId = deps.getSelectedHeadId();
  // Prefer the head whose popover is currently open — that way the warning
  // shows up in the popover you're already looking at. Fall back to other
  // peers if the selected one has no usable sessions.
  const authState = backend.getAuthState();
  const selfHead = authState.signedIn
    ? (heads.find((h) => h.id === rail.userHeadId(authState.user.githubLogin)) ?? null)
    : null;
  const ordered = selectedHeadId
    ? [
        ...heads.filter((h) => h.id === selectedHeadId),
        ...heads.filter((h) => h.id !== selectedHeadId),
      ]
    : heads;
  console.log(
    `[debug] runDebugFireCollision invoked, rail=${heads.length} selected=${selectedHeadId ?? "(none)"}`,
  );

  // Find the first peer whose live (non-ENDED) sessions contain a real file
  // we can collide on. Routes through the same verify-and-mark helper used
  // by the WS path so debug + production produce identical UI guarantees.
  for (const head of ordered) {
    if (head === selfHead) continue;
    const login = rail.parseUserHeadId(head.id);
    if (!login) continue;
    if (!deps.getCachedSessions(head.id)) {
      try {
        await deps.fetchSessionsForHead(head.id);
      } catch {
        continue;
      }
    }
    const sessions = deps.getCachedSessions(head.id);
    const realFile = pickRealFileFromSessions(sessions);
    if (realFile == null) continue;
    console.log(`[debug] fireCollision → ${login} on ${realFile}`);
    await deps.verifyAndMarkCollision(login, realFile);
    return;
  }
  console.warn(
    "[debug] fireCollision: no peer in rail has a live session with edited/written files — try opening Cmd+Shift+' (collision-on-fake) instead, or wait for a teammate to start editing.",
  );
}

/**
 * Returns the first real file path appearing in any of the peer's *live*
 * (non-ENDED) sessions' topFilesEdited/Written. Returns null when none
 * found — the caller should try the next peer rather than fall back to a
 * hardcoded path that won't match any session predicate.
 */
function pickRealFileFromSessions(sessions: InfoSession[] | undefined): string | null {
  if (!sessions) return null;
  const fields: Array<keyof Pick<InfoSession, "topFilesEdited" | "topFilesWritten">> = [
    "topFilesEdited",
    "topFilesWritten",
  ];
  for (const field of fields) {
    for (const s of sessions) {
      if (s.state === "ended") continue;
      const top = s[field];
      if (!Array.isArray(top) || top.length === 0) continue;
      for (const entry of top) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length > 0) {
          return entry[0];
        }
      }
    }
  }
  return null;
}

async function runDebugFireCollisionOnFake(): Promise<void> {
  console.log(`[debug] runDebugFireCollisionOnFake invoked`);
  rail.debugAddFakeTeammate();
  // Fakes have no backend sessions to attach a popover banner to, so we
  // bypass verification and stamp the ring directly. Hovering the fake
  // bubble shows nothing useful — this path is only for testing the
  // ring/halo animation in isolation.
  const heads = rail.list();
  for (let i = heads.length - 1; i > 0; i--) {
    const login = rail.parseUserHeadId(heads[i].id);
    if (!login || !login.startsWith("debug_")) continue;
    rail.markCollision(login, "src/example.ts");
    return;
  }
}

export function registerDebug(d: DebugDeps): void {
  deps = d;

  ipcMain.handle("debug:railSnapshot", () => rail.getDebugSnapshot());
  ipcMain.handle("debug:refreshRail", () => rail.forceRefresh());
  ipcMain.handle("debug:shuffleRail", () => rail.debugShuffleRail());
  ipcMain.handle("debug:addFakeTeammate", () => rail.debugAddFakeTeammate());
  ipcMain.handle("debug:removeFakeTeammate", () => rail.debugRemoveFakeTeammate());
  ipcMain.handle("debug:replayEnterAnimation", () => replayEnterAnimation());
  ipcMain.handle("debug:fireCollision", () => runDebugFireCollision());
  ipcMain.handle("debug:fireCollisionOnFake", () => runDebugFireCollisionOnFake());
  ipcMain.handle("collision:dismiss", (_e, login: string) => {
    if (typeof login === "string" && login.length > 0) rail.dismissCollision(login);
  });
}

// Dev-only globalShortcut bindings. Caller invokes from app.whenReady; harness
// gates on app.isPackaged so packaged builds never register them.
export function registerDebugShortcuts(): void {
  if (app.isPackaged) return;
  const bindings: Array<[string, () => void]> = [
    ["CommandOrControl+Shift+R", () => rail.debugShuffleRail()],
    ["CommandOrControl+Shift+J", () => rail.debugAddFakeTeammate()],
    ["CommandOrControl+Shift+L", () => rail.debugRemoveFakeTeammate()],
    ["CommandOrControl+Shift+K", () => replayEnterAnimation()],
    // Fire a synthetic collision against the first peer (or do nothing if
    // the rail is empty). Picks a real file from the peer's cached sessions
    // so the in-row banner attaches. Using semicolon to avoid OS-level
    // bindings that capture Cmd+Shift+letter combos.
    ["CommandOrControl+Shift+;", () => void runDebugFireCollision()],
    // Same, but spawns a fake teammate first so a single shortcut on an
    // empty rail still produces a visible rail-ring animation.
    ["CommandOrControl+Shift+'", () => void runDebugFireCollisionOnFake()],
    // Toggle devtools for the focused window — no menu/devtools is wired up
    // in this app, so without this the only way to inspect renderer state
    // is to remote-debug via the Vite port.
    [
      "CommandOrControl+Alt+I",
      () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools(),
    ],
  ];
  for (const [accel, fn] of bindings) {
    const ok = globalShortcut.register(accel, fn);
    console.log(`[debug] shortcut ${accel}: ${ok ? "registered" : "FAILED"}`);
  }
}
