// Pure (electron-free) helpers for the strict-tracking gate. Keeping these
// out of `localRepos.ts` lets unit tests exercise them without booting an
// Electron context.

import fs from "node:fs";
import path from "node:path";

/**
 * True when `cwd` lives under any of `trackedPaths`, or under a git linked
 * worktree whose main repo is in `trackedPaths`. Both sides of the prefix
 * check are canonicalized with `realpathSync` so a symlink whose target lies
 * outside every tracked root can't satisfy the gate. Without this, a symlink
 * under e.g. `~/.claude/projects` could point an active session's `cwd` at
 * any directory the user can read, bypassing CLAUDE.md #6.
 */
export function isPathTrackedAgainst(
  cwd: string | null | undefined,
  trackedPaths: readonly string[],
): boolean {
  if (!cwd) return false;
  const abs = canonicalize(cwd);
  if (!abs) return false;
  // Canonicalize each tracked root once and reuse for both the prefix scan
  // and the worktree-fallback scan — `realpathSync` is a syscall per path
  // component, and we'd otherwise pay it twice per tracked root per call.
  const canonicalRoots: string[] = [];
  for (const localPath of trackedPaths) {
    const root = canonicalize(localPath);
    if (root) canonicalRoots.push(root);
  }
  const absWithSep = abs + path.sep;
  for (const root of canonicalRoots) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (absWithSep.startsWith(prefix)) return true;
  }
  const mainRepo = resolveWorktreeMainRepo(abs);
  if (!mainRepo) return false;
  const canonicalMain = canonicalize(mainRepo);
  if (!canonicalMain) return false;
  return canonicalRoots.includes(canonicalMain);
}

// Canonicalize an absolute path through any symlinks. Returns null when the
// path no longer exists or can't be resolved — fail closed so a stale or
// missing tracked root can't accidentally widen the gate.
function canonicalize(p: string): string | null {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}

// A linked worktree's `.git` is a file: `gitdir: <main>/.git/worktrees/<name>`.
// Walk up from cwd, and if we find that shape, return <main>.
function resolveWorktreeMainRepo(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const gitPath = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      // no .git at this level; keep walking up
    }
    if (stat?.isDirectory()) return null; // plain repo, not a worktree
    if (stat?.isFile()) {
      let contents: string;
      try {
        contents = fs.readFileSync(gitPath, "utf8");
      } catch {
        return null;
      }
      const m = contents.match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1]);
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      const idx = gitdir.indexOf(marker);
      return idx === -1 ? null : gitdir.slice(0, idx);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
