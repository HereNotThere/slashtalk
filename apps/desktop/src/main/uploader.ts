// Watches ~/.claude/projects/*/*.jsonl and ships new lines to /v1/ingest.
//
// Strict mode: a session is only tracked if its first event's `cwd` resolves
// under one of the user's tracked local repo paths (localRepos.ts). Sessions
// outside any tracked path are never uploaded.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import * as store from "./store";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const PREFIX_BYTES = 4096; // what the server expects prefixHash to cover
const HEADER_BYTES = 64 * 1024; // how far in we scan for a `cwd` field
const SYNC_STATE_KEY = "uploaderSyncState";
const DEBOUNCE_MS = 150;
const PERSIST_DEBOUNCE_MS = 500;

// Top-level session JSONLs are named <uuid>.jsonl. Claude Code also writes
// subagent streams under <sessionId>/subagents/agent-<id>.jsonl — those are
// not sessions and the server rejects their non-UUID stem.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isSessionJsonl(filePath: string): boolean {
  if (!filePath.endsWith(".jsonl")) return false;
  return UUID_RE.test(path.basename(filePath, ".jsonl"));
}

interface SessionSync {
  byteOffset: number;
  lineSeq: number;
  prefixHash: string;
  // Stat snapshot at the time prefixHash was computed. Lets us skip re-hashing
  // on fs.watch storms when nothing actually changed.
  size: number;
  mtimeMs: number;
  tracked: boolean | null;
}

type SyncState = Record<string, SessionSync>;

let state: SyncState = {};
let watcher: FSWatcher | null = null;
let running = false;
let unsubTracked: (() => void) | null = null;

const inFlight = new Map<string, Promise<void>>();
const pending = new Map<string, NodeJS.Timeout>();
let persistTimer: NodeJS.Timeout | null = null;

// Rescan can queue thousands of files at once; uncapped concurrency blows
// through macOS's default 256 fd limit.
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

// Claude's first JSONL line is often a `file-history-snapshot` event with no
// `cwd`; the field lives on user/assistant events. Try parsing each complete
// line and fall back to a regex scan (cwd values never contain `"`).
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
      const parsed = JSON.parse(line) as { cwd?: unknown };
      if (typeof parsed.cwd === "string") return parsed.cwd;
    } catch {
      // Malformed or partial line — regex fallback below will still find it.
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
      console.error("[uploader] sync failed", filePath, err);
    } finally {
      releaseSlot();
      inFlight.delete(filePath);
    }
  })();
  inFlight.set(filePath, run);
  await run;
}

async function syncFileInner(filePath: string): Promise<void> {
  if (!isSessionJsonl(filePath)) return;

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    console.error("[uploader] stat failed", filePath, err);
    return;
  }
  if (!stat.isFile() || stat.size === 0) return;

  const sessionId = path.basename(filePath, ".jsonl");
  const project = path.basename(path.dirname(filePath));
  let entry = state[sessionId];

  // Fast path: stat unchanged since last visit → nothing to do.
  if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
    return;
  }

  // Truncation / replacement detected — start this session over.
  if (entry && entry.byteOffset > stat.size) {
    entry.byteOffset = 0;
    entry.lineSeq = 0;
    entry.tracked = null;
  }

  const fd = await fsp.open(filePath, "r");
  try {
    if (entry?.tracked === true) {
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      await ingestTail(fd, stat, sessionId, project, entry);
      return;
    }

    if (entry?.tracked === false) {
      // Stays false until localRepos.onChange flips it back to null.
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
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
      };
      state[sessionId] = entry;
    } else {
      entry.prefixHash = prefixHash;
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
    }

    if (cwd === null) {
      // A brand-new session that's only emitted a file-history-snapshot has
      // no cwd yet. Leave tracked=null; re-evaluate on next append.
      return;
    }

    entry.tracked = localRepos.isPathTracked(cwd);
    persistSoon();
    if (!entry.tracked) {
      console.log(`[uploader] skip ${sessionId} — cwd not tracked (${cwd})`);
      return;
    }

    await ingestTail(fd, stat, sessionId, project, entry);
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
  });

  entry.byteOffset += tail.consumed;
  entry.lineSeq = res.serverLineSeq;
  persistSoon();

  console.log(
    `[uploader] ingested ${sessionId} +${res.acceptedEvents} events ` +
      `(${res.duplicateEvents} dup, ${tail.consumed}B) → lineSeq=${res.serverLineSeq}`,
  );
}

// ---------- scan + watch ----------

async function enumerateJsonl(): Promise<string[]> {
  const out: string[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch (err) {
    console.error("[uploader] readdir projects failed", err);
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const subdir = path.join(PROJECTS_DIR, d.name);
    try {
      const files = await fsp.readdir(subdir);
      for (const f of files) {
        const full = path.join(subdir, f);
        if (isSessionJsonl(full)) out.push(full);
      }
    } catch (err) {
      console.error("[uploader] readdir failed", subdir, err);
    }
  }
  return out;
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
    watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const full = path.join(PROJECTS_DIR, filename);
      if (!isSessionJsonl(full)) return;
      schedule(full);
    });
    watcher.on("error", (err) => console.error("[uploader] watcher error", err));
  } catch (err) {
    console.error("[uploader] fs.watch failed", err);
  }
}

async function rescanAll(): Promise<void> {
  const files = await enumerateJsonl();
  console.log(`[uploader] rescan found ${files.length} jsonl files`);
  for (const f of files) schedule(f);
}

// ---------- public API ----------

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  loadState();
  const trackedRoots = localRepos.list().map((r) => r.localPath);
  console.log(
    `[uploader] starting, watching ${PROJECTS_DIR}, ` +
      `tracked roots: ${trackedRoots.length ? trackedRoots.join(", ") : "(none)"}`,
  );
  try {
    await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  } catch (err) {
    console.error("[uploader] mkdir projects failed", err);
  }

  unsubTracked = localRepos.onChange(() => {
    for (const entry of Object.values(state)) entry.tracked = null;
    persistSoon();
    void rescanAll();
  });

  startWatcher();
  await rescanAll();
}

export function stop(): void {
  if (!running) return;
  running = false;
  unsubTracked?.();
  unsubTracked = null;
  watcher?.close();
  watcher = null;
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

/**
 * True once we've successfully ingested ≥1 chunk for this session. Heartbeats
 * check this before firing — the server's heartbeats table has an FK to
 * sessions, so heartbeating a session we haven't ingested yields a 500.
 */
export function hasIngested(sessionId: string): boolean {
  const entry = state[sessionId];
  return !!entry && entry.tracked === true && entry.lineSeq > 0;
}
