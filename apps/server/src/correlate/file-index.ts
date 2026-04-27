/**
 * In-memory cross-session file index for collision detection.
 *
 * Maintains a per-repo map of which live sessions are touching which files,
 * computed off the `topFilesEdited` + `topFilesWritten` aggregates already
 * produced by the ingest pipeline. When a session newly adds a file to its
 * top-touched set and another live session in the same repo (different user)
 * is already touching it, that's a collision.
 *
 * Design notes:
 * - In-memory only. A restart loses the index; that's fine — it's a "right
 *   now" view, not history. The index repopulates as ingests roll in.
 * - TTL prune: entries older than 30 min (matches the RECENT threshold in
 *   sessions/state.ts) are dropped lazily on access.
 * - Throttle: 5-min cooldown per (repo, file, session-pair) to keep the rail
 *   from strobing while two agents stay in the same file.
 * - Same-user multi-session: suppressed. Not a collision, just multitasking.
 * - Lockfiles and similar high-traffic files are ignored by basename.
 */

interface SessionEntry {
  userId: number;
  githubLogin: string;
  files: Set<string>;
  lastSeen: number;
}

interface RepoIndex {
  bySession: Map<string, SessionEntry>;
  byFile: Map<string, Set<string>>;
}

const repos = new Map<number, RepoIndex>();
const lastFiredByPair = new Map<string, number>();

const TTL_MS = 30 * 60_000;
const THROTTLE_MS = 5 * 60_000;

const IGNORE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
]);

function basename(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i === -1 ? norm : norm.slice(i + 1);
}

/**
 * Files we never treat as conflict signal — lockfiles and similar
 * high-traffic paths are noise, not collaboration.
 *
 * Public so other surfaces (e.g. the MCP `get_team_activity` filePath filter)
 * can reuse the same ignore list rather than drift their own.
 */
export function isCollisionIgnoredPath(filePath: string): boolean {
  return IGNORE_BASENAMES.has(basename(filePath));
}

function getRepoIndex(repoId: number): RepoIndex {
  let idx = repos.get(repoId);
  if (!idx) {
    idx = { bySession: new Map(), byFile: new Map() };
    repos.set(repoId, idx);
  }
  return idx;
}

function pruneRepo(idx: RepoIndex, now: number): void {
  for (const [sessionId, entry] of idx.bySession) {
    if (now - entry.lastSeen <= TTL_MS) continue;
    for (const file of entry.files) {
      const set = idx.byFile.get(file);
      if (!set) continue;
      set.delete(sessionId);
      if (set.size === 0) idx.byFile.delete(file);
    }
    idx.bySession.delete(sessionId);
  }
}

export interface DetectArgs {
  repoId: number;
  sessionId: string;
  userId: number;
  githubLogin: string;
  /** Files in this session's top-edited+top-written set after the latest ingest. */
  currentFiles: string[];
  /** Files that were in the session's top-edited+top-written set BEFORE this ingest. */
  priorFiles: string[];
  /** Injectable for tests. Defaults to Date.now(). */
  now?: number;
}

export interface DetectedCollision {
  filePath: string;
  others: Array<{ sessionId: string; userId: number; githubLogin: string }>;
}

/**
 * Detect collisions for this ingest, then update the index.
 *
 * Order matters: we look up against the prior index state so a session never
 * collides with its own prior record, then we record the new state for the
 * next ingest's lookup.
 */
export function detectCollisions(args: DetectArgs): DetectedCollision[] {
  const now = args.now ?? Date.now();
  const idx = getRepoIndex(args.repoId);
  pruneRepo(idx, now);

  const priorSet = new Set(args.priorFiles);
  const newlyAdded = args.currentFiles.filter(
    (f) => !priorSet.has(f) && !isCollisionIgnoredPath(f),
  );

  const collisions: DetectedCollision[] = [];
  for (const file of newlyAdded) {
    const sessionsTouching = idx.byFile.get(file);
    if (!sessionsTouching || sessionsTouching.size === 0) continue;

    const others: DetectedCollision["others"] = [];
    for (const otherSid of sessionsTouching) {
      if (otherSid === args.sessionId) continue;
      const entry = idx.bySession.get(otherSid);
      if (!entry) continue;
      if (entry.userId === args.userId) continue;

      // Throttle per unordered pair-on-this-file. Stops repeat fires when both
      // agents stay in the same file across many ingests.
      const pair = [args.sessionId, otherSid].sort().join("|");
      const key = `${args.repoId}:${file}:${pair}`;
      const lastFired = lastFiredByPair.get(key) ?? 0;
      if (now - lastFired < THROTTLE_MS) continue;
      lastFiredByPair.set(key, now);

      others.push({
        sessionId: otherSid,
        userId: entry.userId,
        githubLogin: entry.githubLogin,
      });
    }
    if (others.length > 0) {
      collisions.push({ filePath: file, others });
    }
  }

  recordSession(args, idx, now);
  return collisions;
}

function recordSession(args: DetectArgs, idx: RepoIndex, now: number): void {
  const prior = idx.bySession.get(args.sessionId);
  const newFiles = new Set(args.currentFiles.filter((f) => !isCollisionIgnoredPath(f)));

  if (prior) {
    for (const old of prior.files) {
      if (newFiles.has(old)) continue;
      const set = idx.byFile.get(old);
      if (!set) continue;
      set.delete(args.sessionId);
      if (set.size === 0) idx.byFile.delete(old);
    }
  }

  for (const file of newFiles) {
    let set = idx.byFile.get(file);
    if (!set) {
      set = new Set();
      idx.byFile.set(file, set);
    }
    set.add(args.sessionId);
  }

  idx.bySession.set(args.sessionId, {
    userId: args.userId,
    githubLogin: args.githubLogin,
    files: newFiles,
    lastSeen: now,
  });
}

/** Test-only: clear all in-memory state. */
export function __resetForTests(): void {
  repos.clear();
  lastFiredByPair.clear();
}
