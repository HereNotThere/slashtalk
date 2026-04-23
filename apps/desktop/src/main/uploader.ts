// Watches both Claude and Codex session JSONLs and ships new lines to
// /v1/ingest. A session is only tracked if its cwd resolves under one of the
// user's tracked local repo paths.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import type { EventSource } from "@slashtalk/shared";
import * as backend from "./backend";
import { createEmitter } from "./emitter";
import * as localRepos from "./localRepos";
import * as store from "./store";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

const PREFIX_BYTES = 4096; // what the server expects prefixHash to cover
const HEADER_BYTES = 64 * 1024; // how far in we scan for source metadata
const SYNC_STATE_KEY = "uploaderSyncState";
const DEBOUNCE_MS = 150;
const PERSIST_DEBOUNCE_MS = 500;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ROLLOUT_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface SessionHeader {
  sessionId: string | null;
  cwd: string | null;
  version: string | null;
  project: string | null;
}

interface SessionSync {
  source: EventSource;
  filePath: string;
  project: string | null;
  cwd: string | null;
  version: string | null;
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

export interface TrackedSessionInfo {
  sessionId: string;
  source: EventSource;
  project: string | null;
  cwd: string | null;
  version: string | null;
  mtimeMs: number;
}

let state: SyncState = {};
let watchers: FSWatcher[] = [];
let running = false;
let unsubTracked: (() => void) | null = null;

const inFlight = new Map<string, Promise<void>>();
const pending = new Map<string, NodeJS.Timeout>();
let persistTimer: NodeJS.Timeout | null = null;

const ingested = createEmitter<{ sessionId: string }>();
export const onIngested = ingested.on;

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

function invalidateDerivedState(): void {
  for (const entry of Object.values(state)) {
    entry.tracked = null;
    entry.size = -1;
  }
}

function loadState(): void {
  const saved = store.get<SyncState>(SYNC_STATE_KEY);
  state = saved && typeof saved === "object" ? saved : {};
  invalidateDerivedState();
}

function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    store.set(SYNC_STATE_KEY, state);
  }, PERSIST_DEBOUNCE_MS);
}

function slugifyPath(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function sourceForPath(filePath: string): EventSource | null {
  if (filePath.startsWith(CLAUDE_PROJECTS_DIR + path.sep)) return "claude";
  if (filePath.startsWith(CODEX_SESSIONS_DIR + path.sep)) return "codex";
  return null;
}

function isClaudeSessionJsonl(filePath: string): boolean {
  return (
    filePath.endsWith(".jsonl") &&
    UUID_RE.test(path.basename(filePath, ".jsonl"))
  );
}

function isCodexSessionJsonl(filePath: string): boolean {
  return CODEX_ROLLOUT_RE.test(path.basename(filePath));
}

function isSessionJsonl(filePath: string): boolean {
  const source = sourceForPath(filePath);
  if (source === "claude") return isClaudeSessionJsonl(filePath);
  if (source === "codex") return isCodexSessionJsonl(filePath);
  return false;
}

function sessionIdFromPath(filePath: string, source: EventSource): string | null {
  if (source === "claude") {
    const sessionId = path.basename(filePath, ".jsonl");
    return UUID_RE.test(sessionId) ? sessionId : null;
  }
  const match = path.basename(filePath).match(CODEX_ROLLOUT_RE);
  return match?.[1] ?? null;
}

function matchQuoted(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  );
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

async function readHeader(
  fd: fsp.FileHandle,
  size: number,
  filePath: string,
  source: EventSource,
): Promise<{ hash: string; header: SessionHeader }> {
  const n = Math.min(HEADER_BYTES, size);
  const buf = Buffer.alloc(n);
  if (n > 0) await fd.read(buf, 0, n, 0);
  const hashSlice = buf.subarray(0, Math.min(PREFIX_BYTES, n));
  const hash = crypto.createHash("sha256").update(hashSlice).digest("hex");
  const header =
    source === "claude"
      ? scanClaudeHeader(buf, filePath)
      : scanCodexHeader(buf, filePath);
  return { hash, header };
}

function scanClaudeHeader(buf: Buffer, filePath: string): SessionHeader {
  const sessionId = sessionIdFromPath(filePath, "claude");
  const cwd = scanForCwd(buf);
  return {
    sessionId,
    cwd,
    version: null,
    project: path.basename(path.dirname(filePath)),
  };
}

function scanCodexHeader(buf: Buffer, filePath: string): SessionHeader {
  const text = buf.toString("utf8");
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let version: string | null = null;
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        cwd?: unknown;
        cli_version?: unknown;
        payload?: {
          id?: unknown;
          cwd?: unknown;
          cli_version?: unknown;
        };
      };
      const payload =
        parsed.payload && typeof parsed.payload === "object"
          ? parsed.payload
          : null;
      if (!sessionId) {
        const value = payload?.id ?? parsed.id;
        if (typeof value === "string") sessionId = value;
      }
      if (!cwd) {
        const value = payload?.cwd ?? parsed.cwd;
        if (typeof value === "string") cwd = value;
      }
      if (!version) {
        const value = payload?.cli_version ?? parsed.cli_version;
        if (typeof value === "string") version = value;
      }
      if (sessionId && cwd && version) break;
    } catch {
      // Partial line — regex fallback below can still recover fields.
    }
  }
  sessionId ??= matchQuoted(text, "id") ?? sessionIdFromPath(filePath, "codex");
  cwd ??= matchQuoted(text, "cwd");
  version ??= matchQuoted(text, "cli_version");
  return {
    sessionId,
    cwd,
    version,
    project: cwd ? slugifyPath(cwd) : null,
  };
}

// Claude's first JSONL line is often a `file-history-snapshot` event with no
// cwd; the field lives on later events. Try parsing complete lines first and
// fall back to a regex scan for truncated headers.
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
      // Partial line — regex fallback below can still recover the field.
    }
  }
  return matchQuoted(text, "cwd");
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
  const source = sourceForPath(filePath);
  if (!source || !isSessionJsonl(filePath)) return;

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    console.error("[uploader] stat failed", filePath, err);
    return;
  }
  if (!stat.isFile() || stat.size === 0) return;

  const guessedSessionId = sessionIdFromPath(filePath, source);
  if (!guessedSessionId) return;
  let entry = state[guessedSessionId];

  if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
    return;
  }

  if (entry && entry.byteOffset > stat.size) {
    entry.byteOffset = 0;
    entry.lineSeq = 0;
    entry.tracked = null;
  }

  const fd = await fsp.open(filePath, "r");
  try {
    if (entry?.tracked === true && entry.project) {
      entry.filePath = filePath;
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      await ingestTail(fd, stat, guessedSessionId, entry);
      return;
    }

    if (entry?.tracked === false) {
      entry.filePath = filePath;
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      return;
    }

    const { hash: prefixHash, header } = await readHeader(fd, stat.size, filePath, source);
    const sessionId = header.sessionId ?? guessedSessionId;
    if (!sessionId) return;

    if (!entry || sessionId !== guessedSessionId) {
      entry = state[sessionId] ?? {
        source,
        filePath,
        project: header.project,
        cwd: header.cwd,
        version: header.version,
        byteOffset: 0,
        lineSeq: 0,
        prefixHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tracked: null,
      };
      state[sessionId] = entry;
      if (sessionId !== guessedSessionId) delete state[guessedSessionId];
    }

    entry.source = source;
    entry.filePath = filePath;
    entry.prefixHash = prefixHash;
    entry.project = header.project;
    entry.cwd = header.cwd;
    entry.version = header.version;
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;

    if (header.cwd === null || header.project === null) {
      return;
    }

    entry.tracked = localRepos.isPathTracked(header.cwd);
    persistSoon();
    if (!entry.tracked) {
      console.log(
        `[uploader] skip ${sessionId} (${source}) — cwd not tracked (${header.cwd})`,
      );
      return;
    }

    await ingestTail(fd, stat, sessionId, entry);
  } finally {
    await fd.close();
  }
}

async function ingestTail(
  fd: fsp.FileHandle,
  stat: fs.Stats,
  sessionId: string,
  entry: SessionSync,
): Promise<void> {
  if (!entry.project || entry.byteOffset >= stat.size) return;
  const tail = await readTail(fd, entry.byteOffset, stat.size);
  if (!tail) return;

  const res = await backend.ingestChunk({
    source: entry.source,
    session: sessionId,
    project: entry.project,
    fromLineSeq: entry.lineSeq,
    prefixHash: entry.prefixHash,
    body: tail.chunk.toString("utf8"),
  });

  entry.byteOffset += tail.consumed;
  entry.lineSeq = res.serverLineSeq;
  persistSoon();

  console.log(
    `[uploader] ingested ${sessionId} (${entry.source}) +${res.acceptedEvents} events ` +
      `(${res.duplicateEvents} dup, ${tail.consumed}B) → lineSeq=${res.serverLineSeq}`,
  );

  if (res.acceptedEvents > 0) ingested.emit({ sessionId });
}

async function walkSessionFiles(
  root: string,
  predicate: (filePath: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error("[uploader] readdir failed", dir, err);
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && predicate(full)) out.push(full);
    }
  }

  return out;
}

async function enumerateAllJsonl(): Promise<string[]> {
  const [claude, codex] = await Promise.all([
    walkSessionFiles(CLAUDE_PROJECTS_DIR, isClaudeSessionJsonl),
    walkSessionFiles(CODEX_SESSIONS_DIR, isCodexSessionJsonl),
  ]);
  return [...claude, ...codex];
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

function watchRoot(root: string): void {
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const full = path.join(root, filename);
      if (!isSessionJsonl(full)) return;
      schedule(full);
    });
    watcher.on("error", (err) => console.error("[uploader] watcher error", err));
    watchers.push(watcher);
  } catch (err) {
    console.error("[uploader] fs.watch failed", root, err);
  }
}

async function rescanAll(): Promise<void> {
  const files = await enumerateAllJsonl();
  console.log(`[uploader] rescan found ${files.length} session jsonl files`);
  for (const filePath of files) schedule(filePath);
}

export function listTrackedSessions(): TrackedSessionInfo[] {
  return Object.entries(state)
    .filter(([, entry]) => entry.tracked === true && entry.lineSeq > 0)
    .map(([sessionId, entry]) => ({
      sessionId,
      source: entry.source,
      project: entry.project,
      cwd: entry.cwd,
      version: entry.version,
      mtimeMs: entry.mtimeMs,
    }));
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  loadState();
  const trackedRoots = localRepos.list().map((repo) => repo.localPath);
  console.log(
    `[uploader] starting, watching ${CLAUDE_PROJECTS_DIR} and ${CODEX_SESSIONS_DIR}, ` +
      `tracked roots: ${trackedRoots.length ? trackedRoots.join(", ") : "(none)"}`,
  );

  for (const root of [CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR]) {
    try {
      await fsp.mkdir(root, { recursive: true });
    } catch (err) {
      console.error("[uploader] mkdir failed", root, err);
    }
  }

  unsubTracked = localRepos.onChange(() => {
    invalidateDerivedState();
    persistSoon();
    void rescanAll();
  });

  watchRoot(CLAUDE_PROJECTS_DIR);
  watchRoot(CODEX_SESSIONS_DIR);
  await rescanAll();
}

export function stop(): void {
  if (!running) return;
  running = false;
  unsubTracked?.();
  unsubTracked = null;
  for (const watcher of watchers) watcher.close();
  watchers = [];
  for (const timer of pending.values()) clearTimeout(timer);
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

export function hasIngested(sessionId: string): boolean {
  const entry = state[sessionId];
  return !!entry && entry.tracked === true && entry.lineSeq > 0;
}
