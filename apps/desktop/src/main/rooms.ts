// Main-process integration for the rooms prototype. Owns:
//  - thin /api/rooms/* HTTP wrappers (uses backend.getJwt() for auth)
//  - per-org room list cache (30s TTL)
//  - WS event → renderer broadcast (rooms:* IPC channels)
//  - applyPatchLocally: shells out to `git apply` against the local clone
//
// `rooms:openWindow` is registered separately in main/index.ts (phase 2)
// because window lifecycle lives there.

import { BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ApplyPatchResult, CreateRoomInput, RoomSnapshot, RoomSummary } from "../shared/types";
import type { OrgRepo, OrgSummary } from "@slashtalk/shared";
import { apiBaseUrl } from "./config";
import * as backend from "./backend";
import { createEmitter } from "./emitter";
import * as localRepos from "./localRepos";
import * as ws from "./ws";

// Refresh interval for the periodic /api/rooms?org=X polling. New rooms
// created by teammates are discovered here; in-place updates for known rooms
// happen via WS events.
const POLL_INTERVAL_MS = 60_000;

// ── HTTP helpers (self-contained — keeps rooms.ts easy to delete) ──

async function api<T>(method: string, p: string, body?: object): Promise<T> {
  const jwt = backend.getJwt();
  if (!jwt) throw new Error("not signed in");
  const res = await fetch(`${apiBaseUrl()}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: `session=${jwt}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${p} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function apiText(p: string): Promise<string> {
  const jwt = backend.getJwt();
  if (!jwt) throw new Error("not signed in");
  const res = await fetch(`${apiBaseUrl()}${p}`, {
    headers: { Cookie: `session=${jwt}` },
  });
  if (!res.ok) throw new Error(`GET ${p} failed (${res.status})`);
  return res.text();
}

// ── Cache + flattened snapshot ──────────────────────────────

const LIST_TTL_MS = 30_000;
const listCache = new Map<string, { rows: RoomSummary[]; at: number }>();
// Flattened across orgs — used by rail.ts to render room chat-heads.
const allRooms = new Map<string, RoomSummary>();
const roomsChanged = createEmitter<RoomSummary[]>();

export const onChange = roomsChanged.on;
export function snapshot(): RoomSummary[] {
  return Array.from(allRooms.values());
}

// Single notification path — both the in-process rail emitter and the
// renderer-facing IPC channel fire from here. Earlier these drifted apart
// (optimistic deletes only fired one), so AgentsSection wasn't refreshing
// when the rail was.
function emitRoomsChanged(): void {
  const snap = snapshot();
  roomsChanged.emit(snap);
  // orgLogin "*" = flattened-across-orgs signal. Renderers re-fetch allRooms
  // on every fire; the payload is informational only.
  broadcast("rooms:listChange", { orgLogin: "*", rooms: snap });
}

function rebuildAllRooms(): void {
  allRooms.clear();
  for (const { rows } of listCache.values()) {
    for (const r of rows) {
      // Drop terminal-state rooms — they shouldn't render on the rail.
      if (r.status === "destroyed" || r.status === "failed") continue;
      allRooms.set(r.id, r);
    }
  }
  emitRoomsChanged();
  syncFastPoll();
}

// While any room is mid-provision, the WS push for status_changed often
// misses an already-open connection (the user wasn't a room_member when the
// connection opened). Speed up the poll so the rail bubble doesn't sit on
// the spinner indefinitely. Drops back to the lazy 60s cadence once all
// known rooms are in a settled state.
const FAST_POLL_INTERVAL_MS = 3_000;
let fastPollTimer: NodeJS.Timeout | null = null;

function syncFastPoll(): void {
  const hasProvisioning = Array.from(allRooms.values()).some((r) => r.status === "provisioning");
  if (hasProvisioning && !fastPollTimer) {
    fastPollTimer = setInterval(() => void refresh(), FAST_POLL_INTERVAL_MS);
  } else if (!hasProvisioning && fastPollTimer) {
    clearInterval(fastPollTimer);
    fastPollTimer = null;
  }
}

async function fetchList(orgLogin: string, opts: { force?: boolean } = {}): Promise<RoomSummary[]> {
  const cached = listCache.get(orgLogin);
  if (!opts.force && cached && Date.now() - cached.at < LIST_TTL_MS) {
    return cached.rows;
  }
  const res = await api<{ rooms: RoomSummary[] }>(
    "GET",
    `/api/rooms?org=${encodeURIComponent(orgLogin)}`,
  );
  listCache.set(orgLogin, { rows: res.rooms, at: Date.now() });
  rebuildAllRooms(); // emits the flat broadcast — no per-org broadcast needed
  return res.rooms;
}

/** Refresh every org list — used by the periodic poller and on signed-in
 *  start to populate the flattened snapshot rail.ts consumes. */
export async function refresh(): Promise<void> {
  if (!backend.getJwt()) return;
  let orgs: OrgSummary[];
  try {
    orgs = await api<OrgSummary[]>("GET", "/api/me/orgs");
  } catch (err) {
    console.warn("[rooms] orgs fetch failed:", (err as Error).message);
    return;
  }
  await Promise.all(
    orgs.map((o) =>
      fetchList(o.login, { force: true }).catch((err) =>
        console.warn(`[rooms] list ${o.login} failed:`, (err as Error).message),
      ),
    ),
  );
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send(channel, payload);
  }
}

// ── Apply patch locally ────────────────────────────────────

async function applyPatchLocally(roomId: string, repoId: number): Promise<ApplyPatchResult> {
  const tracked = localRepos.list().find((r) => r.repoId === repoId);
  if (!tracked) {
    return { applied: false, error: "no local clone tracked for this repo" };
  }
  let patch: string;
  try {
    patch = await apiText(`/api/rooms/${roomId}/patch`);
  } catch (err) {
    return { applied: false, error: (err as Error).message };
  }
  if (!patch.trim()) return { applied: false, error: "patch is empty" };

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "slashtalk-patch-"));
  const patchPath = path.join(tmpDir, `room-${roomId}.patch`);
  try {
    await writeFile(patchPath, patch, "utf8");
    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn("git", ["apply", "--3way", patchPath], {
        cwd: tracked.localPath,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
      child.on("error", (err) => resolve({ code: -1, stderr: err.message }));
    });
    if (result.code !== 0) {
      return { applied: false, error: result.stderr.trim() || `git apply exit ${result.code}` };
    }
    return { applied: true };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Wiring ─────────────────────────────────────────────────

let started = false;

export function registerRoomsIpc(): void {
  if (started) return;
  started = true;

  ipcMain.handle("rooms:listOrgs", async () => api<OrgSummary[]>("GET", "/api/me/orgs"));

  ipcMain.handle("rooms:listOrgRepos", async (_e, orgLogin: string) =>
    api<OrgRepo[]>("GET", `/api/me/orgs/${encodeURIComponent(orgLogin)}/repos`),
  );

  ipcMain.handle("rooms:list", async (_e, orgLogin: string) => fetchList(orgLogin));

  ipcMain.handle("rooms:allRooms", () => snapshot());

  ipcMain.handle("rooms:get", async (_e, roomId: string) =>
    api<RoomSnapshot>("GET", `/api/rooms/${roomId}`),
  );

  ipcMain.handle("rooms:create", async (_e, input: CreateRoomInput) => {
    const res = await api<{ room: RoomSummary }>("POST", "/api/rooms", input);
    // Invalidate cache for the room's org so the next list() refetches.
    const orgLogin = res.room.orgLogin;
    listCache.delete(orgLogin);
    void fetchList(orgLogin, { force: true });
    return res.room;
  });

  ipcMain.handle("rooms:postMessage", async (_e, roomId: string, text: string) =>
    api<{ seq: number }>("POST", `/api/rooms/${roomId}/messages`, { text }),
  );

  ipcMain.handle("rooms:postAgent", async (_e, roomId: string, prompt: string) => {
    await api<{ ok: true }>("POST", `/api/rooms/${roomId}/agent`, { prompt });
  });

  ipcMain.handle("rooms:patch", async (_e, roomId: string) =>
    apiText(`/api/rooms/${roomId}/patch`),
  );

  ipcMain.handle("rooms:applyPatchLocally", async (_e, roomId: string, repoId: number) =>
    applyPatchLocally(roomId, repoId),
  );

  ipcMain.handle("rooms:delete", async (_e, roomId: string) => {
    await api<{ ok: true }>("DELETE", `/api/rooms/${roomId}`);
    // Surgical removal: pull the destroyed room out of allRooms AND each
    // org's list cache, but leave OTHER rooms in place. Earlier we did
    // `listCache.clear() + void refresh()`, which briefly emptied allRooms
    // while the refetch was in flight — every other room bubble flickered
    // off the rail.
    allRooms.delete(roomId);
    for (const [orgLogin, entry] of listCache.entries()) {
      const filtered = entry.rows.filter((r) => r.id !== roomId);
      if (filtered.length !== entry.rows.length) {
        listCache.set(orgLogin, { rows: filtered, at: entry.at });
      }
    }
    emitRoomsChanged();
    syncFastPoll();
  });

  // WS → IPC fan-out. Renderers subscribe via chatheads.rooms.on*.
  ws.onRoomMessageCreated((msg) => {
    // Forward to renderers (the room window appends it to the log) but
    // intentionally do NOT touch allRooms or fire roomsChanged here — that
    // chains into rail.scheduleRefresh, which would refetch peers + feed on
    // every chat / agent_typing / system row and thrash the rail. The next
    // periodic poll picks up server-side lastActivityAt churn.
    broadcast("rooms:messageCreated", msg);
  });
  ws.onRoomStatusChanged((msg) => {
    broadcast("rooms:statusChanged", msg);
    const existing = allRooms.get(msg.roomId);
    if (existing) {
      if (msg.status === "destroyed") {
        allRooms.delete(msg.roomId);
      } else {
        allRooms.set(msg.roomId, { ...existing, status: msg.status });
      }
      // Status flips drive the rail visual (spinner ↔ ring) — emit so the
      // rail rebuilds. Message rows don't, so they skip the emit above.
      emitRoomsChanged();
      syncFastPoll();
    }
  });
  ws.onRoomAgentDelta((msg) => {
    broadcast("rooms:agentDelta", msg);
  });
  ws.onRoomMemberJoined((msg) => {
    broadcast("rooms:memberJoined", msg);
  });
}

let pollTimer: NodeJS.Timeout | null = null;

/** Begin periodic /api/rooms polling. Called on app ready; cheap to leave
 *  running across sign-out (refresh() bails when there's no JWT). */
export function start(): void {
  void refresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
}
