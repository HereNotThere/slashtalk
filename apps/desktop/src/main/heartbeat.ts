// Sends /v1/heartbeat for live Claude and Codex sessions that belong to a
// tracked repo and have already been ingested.

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

const FALLBACK_MS = 15_000;
const CHANGE_DEBOUNCE_MS = 250;
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
  const sessionId =
    typeof parsed.sessionId === "string" ? parsed.sessionId : null;
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
        session.source === "codex" &&
        session.cwd &&
        now - session.mtimeMs <= CODEX_LIVE_WINDOW_MS,
    )
    .map((session) => ({
      sessionId: session.sessionId,
      kind: "codex",
      cwd: session.cwd ?? undefined,
      version: session.version ?? undefined,
    }));
}

async function enumerateLive(): Promise<LiveSession[]> {
  const [claude, codex] = await Promise.all([
    enumerateClaudeLive(),
    Promise.resolve(enumerateCodexLive(Date.now())),
  ]);
  return [...claude, ...codex];
}

async function pulse(): Promise<void> {
  if (!running) return;
  const live = await enumerateLive();
  await Promise.all(
    live.map((session) =>
      backend
        .sendHeartbeat(session)
        .then(() =>
          console.log(
            `[heartbeat] sent ${session.sessionId}` +
              (session.pid ? ` pid=${session.pid}` : ` kind=${session.kind ?? "-"}`),
          ),
        )
        .catch((err) =>
          console.error("[heartbeat] send failed", session.sessionId, err),
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
  for (const root of [CLAUDE_SESSIONS_DIR, CODEX_SESSIONS_DIR]) {
    try {
      await fsp.mkdir(root, { recursive: true });
    } catch (err) {
      console.error("[heartbeat] mkdir failed", root, err);
    }
  }
  unsubTracked = localRepos.onChange(() => schedulePulse());
  watchRoot(CLAUDE_SESSIONS_DIR);
  watchRoot(CODEX_SESSIONS_DIR);
  timer = setInterval(() => void pulse(), FALLBACK_MS);
  await pulse();
}

export function stop(): void {
  if (!running) return;
  running = false;
  for (const watcher of watchers) watcher.close();
  watchers = [];
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
