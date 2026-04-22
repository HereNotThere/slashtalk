/**
 * Local helpers for mapping a Claude Code session's cwd/project back to a
 * repo the user has claimed. Read-only OAuth means we can't sync repos from
 * GitHub server-side — repos are claimed on-demand via POST /api/me/repos.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { repos, userRepos, deviceRepoPaths } from "../db/schema";

/**
 * Try to match a session's cwd/project to a known repo.
 *
 * Strategy (most specific first):
 *   1. Device repo paths — check if cwd is inside a known local clone path
 *      reported by the desktop/install client (handles subdirectories)
 *   2. Walk up cwd — try owner/name then name at every directory level
 *   3. Project slug fallback — check if slug ends with a repo name
 */
export async function matchSessionRepo(
  db: Database,
  userId: number,
  cwdOrNull: string | null,
  project: string,
  deviceId?: number | null
): Promise<number | null> {
  if (!cwdOrNull && !project) return null;

  // Strategy 1: device_repo_paths (most accurate, handles subdirs)
  if (deviceId && cwdOrNull) {
    const paths = await db
      .select({ repoId: deviceRepoPaths.repoId, localPath: deviceRepoPaths.localPath })
      .from(deviceRepoPaths)
      .where(eq(deviceRepoPaths.deviceId, deviceId));

    // Longest-prefix match so /Users/a/org/repo wins over /Users/a
    const sorted = paths.sort((a, b) => b.localPath.length - a.localPath.length);
    for (const p of sorted) {
      if (cwdOrNull === p.localPath || cwdOrNull.startsWith(p.localPath + "/")) {
        return p.repoId;
      }
    }
  }

  // Load user's repos for strategies 2 & 3
  const userRepoRows = await db
    .select({ repoId: repos.id, name: repos.name, fullName: repos.fullName })
    .from(userRepos)
    .innerJoin(repos, eq(repos.id, userRepos.repoId))
    .where(eq(userRepos.userId, userId));

  if (userRepoRows.length === 0) return null;

  // Strategy 2: walk UP the cwd path, trying owner/name then name at each level
  if (cwdOrNull) {
    const parts = cwdOrNull.split("/").filter(Boolean);
    for (let i = parts.length; i >= 1; i--) {
      const dirName = parts[i - 1];
      if (i >= 2) {
        const ownerRepo = `${parts[i - 2]}/${dirName}`;
        const match = userRepoRows.find((r) => r.fullName === ownerRepo);
        if (match) return match.repoId;
      }
      const match = userRepoRows.find((r) => r.name === dirName);
      if (match) return match.repoId;
    }
  }

  // Strategy 3: project slug fallback
  for (const row of userRepoRows) {
    if (project.endsWith(row.name) || project.endsWith(`-${row.name}`)) {
      return row.repoId;
    }
  }

  return null;
}
