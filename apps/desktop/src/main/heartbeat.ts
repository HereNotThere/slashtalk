// Sends /v1/heartbeat for every live ~/.claude/sessions/*.json whose cwd
// resolves under a tracked local repo AND whose session has already been
// ingested by the uploader (the server's heartbeats FK into sessions).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as uploader from "./uploader";

const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const FALLBACK_MS = 15_000;
const CHANGE_DEBOUNCE_MS = 250;

interface LiveSession {
  sessionId: string;
  pid: number;
  kind?: string;
  cwd?: string;
  version?: string;
  startedAt?: string;
}

let watcher: FSWatcher | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let pendingTimer: NodeJS.Timeout | null = null;
let unsubTracked: (() => void) | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH from kill(0) is the "pid is dead" signal, not an error.
    return false;
  }
}

async function readLiveSession(filePath: string): Promise<LiveSession | null> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    console.error("[heartbeat] readFile failed", filePath, err);
    return null;
  }
  let parsed: {
    pid?: unknown;
    sessionId?: unknown;
    kind?: unknown;
    cwd?: unknown;
    version?: unknown;
    startedAt?: unknown;
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error("[heartbeat] malformed session file", filePath, err);
    return null;
  }
  const pid = typeof parsed.pid === "number" ? parsed.pid : null;
  const sessionId =
    typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  if (pid === null || !sessionId) return null;
  let startedAt: string | undefined;
  if (typeof parsed.startedAt === "number")
    startedAt = new Date(parsed.startedAt).toISOString();
  else if (typeof parsed.startedAt === "string") startedAt = parsed.startedAt;
  return {
    pid,
    sessionId,
    kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    version: typeof parsed.version === "string" ? parsed.version : undefined,
    startedAt,
  };
}

async function enumerateLive(): Promise<LiveSession[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(SESSIONS_DIR);
  } catch (err) {
    console.error("[heartbeat] readdir sessions failed", err);
    return [];
  }
  const out: LiveSession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const s = await readLiveSession(path.join(SESSIONS_DIR, name));
    if (!s) continue;
    if (!pidAlive(s.pid)) continue;
    if (!localRepos.isPathTracked(s.cwd)) continue;
    if (!uploader.hasIngested(s.sessionId)) continue;
    out.push(s);
  }
  return out;
}

async function pulse(): Promise<void> {
  if (!running) return;
  const live = await enumerateLive();
  await Promise.all(
    live.map((s) =>
      backend
        .sendHeartbeat(s)
        .then(() =>
          console.log(`[heartbeat] sent ${s.sessionId} pid=${s.pid}`),
        )
        .catch((err) =>
          console.error("[heartbeat] send failed", s.sessionId, err),
        ),
    ),
  );
}

function schedulePulse(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void pulse();
  }, CHANGE_DEBOUNCE_MS);
}

function startWatcher(): void {
  try {
    watcher = fs.watch(SESSIONS_DIR, () => schedulePulse());
    watcher.on("error", (err) => console.error("[heartbeat] watcher error", err));
  } catch (err) {
    console.error("[heartbeat] fs.watch failed", err);
  }
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  } catch (err) {
    console.error("[heartbeat] mkdir sessions failed", err);
  }
  unsubTracked = localRepos.onChange(() => schedulePulse());
  startWatcher();
  timer = setInterval(() => void pulse(), FALLBACK_MS);
  await pulse();
}

export function stop(): void {
  if (!running) return;
  running = false;
  watcher?.close();
  watcher = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  unsubTracked?.();
  unsubTracked = null;
}
