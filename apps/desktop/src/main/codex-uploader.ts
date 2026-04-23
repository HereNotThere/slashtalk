// Watches ~/.codex/sessions/**/rollout-*-<uuid>.jsonl and ships new lines
// to /v1/ingest?source=codex.
//
// Strict mode: a session is only tracked if the first line's
// `session_meta.payload.cwd` resolves under one of the user's tracked local
// repo paths. Sessions outside any tracked path are never uploaded.
//
// Codex has no external pid file like Claude's ~/.claude/sessions, so
// liveness heartbeats piggy-back on this watcher: we heartbeat after each
// successful ingest and on a 15s pulse for any rollout whose mtime is within
// the last minute.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as store from "./store";

const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const PREFIX_BYTES = 4096;
const HEADER_BYTES = 64 * 1024;
const SYNC_STATE_KEY = "codexUploaderSyncState";
const DEBOUNCE_MS = 150;
const PERSIST_DEBOUNCE_MS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_LIVENESS_MS = 60_000;

// Basename matches "rollout-<iso-with-dashes>-<uuid>" — uuid is the last
// 36-char group. Subagent streams (if Codex ever writes them) use a
// different prefix and will be rejected.
const ROLLOUT_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function sessionIdFromPath(filePath: string): string | null {
  if (!filePath.endsWith(".jsonl")) return null;
  const base = path.basename(filePath, ".jsonl");
  const m = base.match(ROLLOUT_RE);
  return m ? m[1].toLowerCase() : null;
}

function toProjectSlug(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

interface SessionSync {
  byteOffset: number;
  lineSeq: number;
  prefixHash: string;
  size: number;
  mtimeMs: number;
  tracked: boolean | null;
  project: string | null;
  sessionId: string;
  filePath: string;
}

type SyncState = Record<string, SessionSync>;

let state: SyncState = {};
let watcher: FSWatcher | null = null;
let running = false;
let unsubTracked: (() => void) | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

const inFlight = new Map<string, Promise<void>>();
const pending = new Map<string, NodeJS.Timeout>();
let persistTimer: NodeJS.Timeout | null = null;

const MAX_CONCURRENT_SYNCS = 16;
let activeSlots = 0;
const slotQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeSlots < MAX_CONCURRENT_SYNCS) {
    activeSlots++;
    return Promise.resolve();
  }
  return new Promise((resolve) => slotQueue.push(resolve));
}

function releaseSlot(): void {
  const next = slotQueue.shift();
  if (next) next();
  else activeSlots--;
}

// ---------- persistence ----------

function loadState(): void {
  const saved = store.get<SyncState>(SYNC_STATE_KEY);
  state = saved && typeof saved === "object" ? saved : {};
}

function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    store.set(SYNC_STATE_KEY, state);
  }, PERSIST_DEBOUNCE_MS);
}

// ---------- file primitives ----------

async function readHeader(
  fd: fsp.FileHandle,
  size: number,
): Promise<{ hash: string; cwd: string | null }> {
  const n = Math.min(HEADER_BYTES, size);
  const buf = Buffer.alloc(n);
  if (n > 0) await fd.read(buf, 0, n, 0);
  const hashSlice = buf.subarray(0, Math.min(PREFIX_BYTES, n));
  const hash = crypto.createHash("sha256").update(hashSlice).digest("hex");
  return { hash, cwd: scanForCwd(buf) };
}

// Codex's first line is always a session_meta event whose payload carries
// cwd. Parse each complete line; regex fallback catches the case where the
// payload straddles the 64KB read.
function scanForCwd(buf: Buffer): string | null {
  const text = buf.toString("utf8");
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        payload?: { cwd?: unknown };
      };
      if (parsed.payload && typeof parsed.payload.cwd === "string") {
        return parsed.payload.cwd;
      }
    } catch {
      // fall through to regex
    }
  }
  const m = text.match(/"cwd":"([^"]+)"/);
  return m ? m[1] : null;
}

async function readTail(
  fd: fsp.FileHandle,
  from: number,
  size: number,
): Promise<{ chunk: Buffer; consumed: number } | null> {
  if (from >= size) return null;
  const len = size - from;
  const buf = Buffer.alloc(len);
  await fd.read(buf, 0, len, from);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return null;
  return { chunk: buf.subarray(0, lastNl + 1), consumed: lastNl + 1 };
}

// ---------- core sync ----------

async function syncFile(filePath: string): Promise<void> {
  const existing = inFlight.get(filePath);
  if (existing) {
    await existing;
    return;
  }
  const run = (async () => {
    await acquireSlot();
    try {
      await syncFileInner(filePath);
    } catch (err) {
      console.error("[codex-uploader] sync failed", filePath, err);
    } finally {
      releaseSlot();
      inFlight.delete(filePath);
    }
  })();
  inFlight.set(filePath, run);
  await run;
}

async function syncFileInner(filePath: string): Promise<void> {
  const sessionId = sessionIdFromPath(filePath);
  if (!sessionId) return;

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    console.error("[codex-uploader] stat failed", filePath, err);
    return;
  }
  if (!stat.isFile() || stat.size === 0) return;

  let entry = state[sessionId];

  if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
    return;
  }

  // Truncation / replacement → restart this session.
  if (entry && entry.byteOffset > stat.size) {
    entry.byteOffset = 0;
    entry.lineSeq = 0;
    entry.tracked = null;
  }

  const fd = await fsp.open(filePath, "r");
  try {
    if (entry?.tracked === true && entry.project) {
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      entry.filePath = filePath;
      await ingestTail(fd, stat, sessionId, entry.project, entry);
      return;
    }

    if (entry?.tracked === false) {
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      entry.filePath = filePath;
      return;
    }

    const { hash: prefixHash, cwd } = await readHeader(fd, stat.size);
    if (!entry) {
      entry = {
        byteOffset: 0,
        lineSeq: 0,
        prefixHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tracked: null,
        project: null,
        sessionId,
        filePath,
      };
      state[sessionId] = entry;
    } else {
      entry.prefixHash = prefixHash;
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      entry.filePath = filePath;
    }

    if (cwd === null) {
      // session_meta hasn't been flushed yet — retry on next append.
      return;
    }

    entry.tracked = localRepos.isPathTracked(cwd);
    entry.project = toProjectSlug(cwd);
    persistSoon();
    if (!entry.tracked) {
      console.log(
        `[codex-uploader] skip ${sessionId} — cwd not tracked (${cwd})`,
      );
      return;
    }

    await ingestTail(fd, stat, sessionId, entry.project, entry);
  } finally {
    await fd.close();
  }
}

async function ingestTail(
  fd: fsp.FileHandle,
  stat: fs.Stats,
  sessionId: string,
  project: string,
  entry: SessionSync,
): Promise<void> {
  if (entry.byteOffset >= stat.size) return;
  const tail = await readTail(fd, entry.byteOffset, stat.size);
  if (!tail) return;

  const res = await backend.ingestChunk({
    session: sessionId,
    project,
    fromLineSeq: entry.lineSeq,
    prefixHash: entry.prefixHash,
    body: tail.chunk.toString("utf8"),
    source: "codex",
  });

  entry.byteOffset += tail.consumed;
  entry.lineSeq = res.serverLineSeq;
  persistSoon();

  console.log(
    `[codex-uploader] ingested ${sessionId} +${res.acceptedEvents} events ` +
      `(${res.duplicateEvents} dup, ${tail.consumed}B) → lineSeq=${res.serverLineSeq}`,
  );

  // Fire a heartbeat straight after a successful ingest — activity means the
  // codex session is live. pid/kind are optional in the heartbeat body.
  void backend
    .sendHeartbeat({ sessionId, kind: "codex" })
    .catch((err) =>
      console.error("[codex-uploader] heartbeat failed", sessionId, err),
    );
}

// ---------- heartbeat pulse ----------

async function pulseHeartbeats(): Promise<void> {
  if (!running) return;
  const cutoff = Date.now() - HEARTBEAT_LIVENESS_MS;
  const tasks: Promise<unknown>[] = [];
  for (const entry of Object.values(state)) {
    if (entry.tracked !== true) continue;
    if (entry.lineSeq <= 0) continue; // server-side FK requires a session row
    if (entry.mtimeMs < cutoff) continue;
    tasks.push(
      backend
        .sendHeartbeat({ sessionId: entry.sessionId, kind: "codex" })
        .catch((err) =>
          console.error(
            "[codex-uploader] pulse heartbeat failed",
            entry.sessionId,
            err,
          ),
        ),
    );
  }
  await Promise.all(tasks);
}

// ---------- scan + watch ----------

async function enumerateJsonl(): Promise<string[]> {
  const out: string[] = [];
  await walk(SESSIONS_DIR, out, 0);
  return out;
}

async function walk(
  dir: string,
  out: string[],
  depth: number,
): Promise<void> {
  // Codex shards by YYYY/MM/DD — depth 3 is the file layer.
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      await walk(full, out, depth + 1);
    } else if (d.isFile() && sessionIdFromPath(full)) {
      out.push(full);
    }
  }
}

function schedule(filePath: string): void {
  const existing = pending.get(filePath);
  if (existing) clearTimeout(existing);
  pending.set(
    filePath,
    setTimeout(() => {
      pending.delete(filePath);
      void syncFile(filePath);
    }, DEBOUNCE_MS),
  );
}

function startWatcher(): void {
  try {
    watcher = fs.watch(
      SESSIONS_DIR,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        const full = path.join(SESSIONS_DIR, filename);
        if (!sessionIdFromPath(full)) return;
        schedule(full);
      },
    );
    watcher.on("error", (err) =>
      console.error("[codex-uploader] watcher error", err),
    );
  } catch (err) {
    console.error("[codex-uploader] fs.watch failed", err);
  }
}

async function rescanAll(): Promise<void> {
  const files = await enumerateJsonl();
  console.log(`[codex-uploader] rescan found ${files.length} rollout files`);
  for (const f of files) schedule(f);
}

// ---------- public API ----------

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  loadState();
  const trackedRoots = localRepos.list().map((r) => r.localPath);
  console.log(
    `[codex-uploader] starting, watching ${SESSIONS_DIR}, ` +
      `tracked roots: ${trackedRoots.length ? trackedRoots.join(", ") : "(none)"}`,
  );
  try {
    await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  } catch (err) {
    console.error("[codex-uploader] mkdir sessions failed", err);
  }

  unsubTracked = localRepos.onChange(() => {
    for (const entry of Object.values(state)) entry.tracked = null;
    persistSoon();
    void rescanAll();
  });

  startWatcher();
  heartbeatTimer = setInterval(() => void pulseHeartbeats(), HEARTBEAT_INTERVAL_MS);
  await rescanAll();
}

export function stop(): void {
  if (!running) return;
  running = false;
  unsubTracked?.();
  unsubTracked = null;
  watcher?.close();
  watcher = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    store.set(SYNC_STATE_KEY, state);
  }
}

export function reset(): void {
  stop();
  state = {};
  store.del(SYNC_STATE_KEY);
}
