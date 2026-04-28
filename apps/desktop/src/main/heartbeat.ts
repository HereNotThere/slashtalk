// Sends /v1/heartbeat for live Claude, Codex, and Cursor sessions that have
// already been ingested.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as uploader from "./uploader";

const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const CURSOR_PROJECTS_DIR = path.join(os.homedir(), ".cursor", "projects");

const FALLBACK_MS = 15_000;
const FAIL_BACKOFF_MAX_MS = 5 * 60_000;
const CHANGE_DEBOUNCE_MS = 250;
// File watchers fire on every JSONL append while a session is live, so without
// a per-session floor the global 250ms debounce becomes the heartbeat cadence.
const MIN_PER_SESSION_MS = 10_000;
const CODEX_LIVE_WINDOW_MS = 10 * 60_000;

interface LiveSession {
  sessionId: string;
  pid?: number;
  kind?: string;
  cwd?: string;
  version?: string;
  startedAt?: string;
}

let watchers: FSWatcher[] = [];
let timer: NodeJS.Timeout | null = null;
let running = false;
let pendingTimer: NodeJS.Timeout | null = null;
let unsubTracked: (() => void) | null = null;
let consecutiveFailures = 0;
const lastSentBySession = new Map<string, number>();

// Exponential backoff capped at FAIL_BACKOFF_MAX_MS so a server outage doesn't
// pin the desktop to a 15s retry storm. Successful pulse() resets the counter.
function nextPulseDelay(): number {
  if (consecutiveFailures === 0) return FALLBACK_MS;
  const grown = FALLBACK_MS * 2 ** Math.min(consecutiveFailures, 8);
  return Math.min(grown, FAIL_BACKOFF_MAX_MS);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readClaudeLiveSession(filePath: string): Promise<LiveSession | null> {
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
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  if (pid === null || !sessionId) return null;

  let startedAt: string | undefined;
  if (typeof parsed.startedAt === "number") {
    startedAt = new Date(parsed.startedAt).toISOString();
  } else if (typeof parsed.startedAt === "string") {
    startedAt = parsed.startedAt;
  }

  return {
    pid,
    sessionId,
    kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    version: typeof parsed.version === "string" ? parsed.version : undefined,
    startedAt,
  };
}

async function enumerateClaudeLive(): Promise<LiveSession[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(CLAUDE_SESSIONS_DIR);
  } catch (err) {
    console.error("[heartbeat] readdir sessions failed", err);
    return [];
  }

  const out: LiveSession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const session = await readClaudeLiveSession(path.join(CLAUDE_SESSIONS_DIR, name));
    if (!session?.pid || !pidAlive(session.pid)) continue;
    if (!localRepos.isPathTracked(session.cwd)) continue;
    if (!uploader.hasIngested(session.sessionId)) continue;
    out.push(session);
  }
  return out;
}

function enumerateCodexLive(now: number): LiveSession[] {
  return uploader
    .listTrackedSessions()
    .filter(
      (session) =>
        session.source === "codex" && session.cwd && now - session.mtimeMs <= CODEX_LIVE_WINDOW_MS,
    )
    .map((session) => ({
      sessionId: session.sessionId,
      kind: "codex",
      cwd: session.cwd ?? undefined,
      version: session.version ?? undefined,
    }));
}

function enumerateCursorLive(now: number): LiveSession[] {
  return uploader
    .listTrackedSessions()
    .filter(
      (session) =>
        session.source === "cursor" && session.cwd && now - session.mtimeMs <= CODEX_LIVE_WINDOW_MS,
    )
    .map((session) => ({
      sessionId: session.sessionId,
      kind: "cursor",
      cwd: session.cwd ?? undefined,
      version: session.version ?? undefined,
    }));
}

async function enumerateLive(): Promise<LiveSession[]> {
  const now = Date.now();
  const [claude, codex, cursor] = await Promise.all([
    enumerateClaudeLive(),
    Promise.resolve(enumerateCodexLive(now)),
    Promise.resolve(enumerateCursorLive(now)),
  ]);
  return [...claude, ...codex, ...cursor];
}

async function pulse(): Promise<void> {
  if (!running) return;
  const live = await enumerateLive();
  const now = Date.now();
  const liveIds = new Set(live.map((s) => s.sessionId));
  for (const id of lastSentBySession.keys()) {
    if (!liveIds.has(id)) lastSentBySession.delete(id);
  }
  const due = live.filter((s) => {
    const last = lastSentBySession.get(s.sessionId) ?? 0;
    return now - last >= MIN_PER_SESSION_MS;
  });
  // Track per-pulse outcomes so a single mixed batch (some sent, some failed)
  // is treated as healthy — backoff only kicks in when every send fails or
  // there's nothing to send and the prior pulse was already failing.
  let attempted = 0;
  let failed = 0;
  await Promise.all(
    due.map((session) => {
      attempted++;
      return backend
        .sendHeartbeat(session)
        .then(() => {
          lastSentBySession.set(session.sessionId, Date.now());
          console.log(
            `[heartbeat] sent ${session.sessionId}` +
              (session.pid ? ` pid=${session.pid}` : ` kind=${session.kind ?? "-"}`),
          );
        })
        .catch((err) => {
          failed++;
          console.error("[heartbeat] send failed", session.sessionId, err);
        });
    }),
  );
  if (attempted > 0 && failed === attempted) {
    consecutiveFailures++;
  } else if (attempted > 0) {
    consecutiveFailures = 0;
  }
}

function schedulePulse(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void pulse();
  }, CHANGE_DEBOUNCE_MS);
}

function watchRoot(root: string): void {
  try {
    const watcher = fs.watch(root, { recursive: true }, () => schedulePulse());
    watcher.on("error", (err) => console.error("[heartbeat] watcher error", err));
    watchers.push(watcher);
  } catch (err) {
    console.error("[heartbeat] fs.watch failed", root, err);
  }
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  for (const root of [CLAUDE_SESSIONS_DIR, CODEX_SESSIONS_DIR, CURSOR_PROJECTS_DIR]) {
    try {
      await fsp.mkdir(root, { recursive: true });
    } catch (err) {
      console.error("[heartbeat] mkdir failed", root, err);
    }
  }
  unsubTracked = localRepos.onChange(() => schedulePulse());
  watchRoot(CLAUDE_SESSIONS_DIR);
  watchRoot(CODEX_SESSIONS_DIR);
  watchRoot(CURSOR_PROJECTS_DIR);
  scheduleNextPulse();
  await pulse();
}

// Self-rescheduling so the cadence reflects the live failure state — a stable
// 15s setInterval would hammer a down server for hours.
function scheduleNextPulse(): void {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      await pulse();
    } finally {
      scheduleNextPulse();
    }
  }, nextPulseDelay());
}

export function stop(): void {
  if (!running) return;
  running = false;
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  consecutiveFailures = 0;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  unsubTracked?.();
  unsubTracked = null;
  lastSentBySession.clear();
}
