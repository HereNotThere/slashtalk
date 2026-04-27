/**
 * Local helpers for mapping a Claude Code session's cwd/project back to a
 * repo the user has claimed. Read-only OAuth means we can't sync repos from
 * GitHub server-side — repos are claimed on-demand via POST /api/me/repos.
 */

import { eq, and } from "drizzle-orm";
import type { Database } from "../db";
import { repos, userRepos, deviceRepoPaths, deviceExcludedRepos } from "../db/schema";

function toProjectSlug(path: string): string {
  return path.replaceAll("/", "-");
}

/** Canonical form for repos.full_name / repos.name / repos.owner. GitHub is
 *  case-insensitive; we store and compare lowercased so that `.git/config`
 *  casing differences don't split the social graph. */
export function normalizeFullName(s: string): string {
  return s.toLowerCase();
}

async function isRepoExcludedForDevice(
  db: Database,
  deviceId: number | null | undefined,
  repoId: number,
): Promise<boolean> {
  if (!deviceId) return false;

  const [excluded] = await db
    .select({ repoId: deviceExcludedRepos.repoId })
    .from(deviceExcludedRepos)
    .where(and(eq(deviceExcludedRepos.deviceId, deviceId), eq(deviceExcludedRepos.repoId, repoId)))
    .limit(1);

  return Boolean(excluded);
}

async function acceptRepoCandidate(
  db: Database,
  deviceId: number | null | undefined,
  repoId: number,
): Promise<number | null> {
  return (await isRepoExcludedForDevice(db, deviceId, repoId)) ? null : repoId;
}

/**
 * Try to match a session's cwd/project to a known repo.
 *
 * Strategy (most specific first):
 *   1. Device repo paths — check if cwd or project slug is inside a known
 *      local clone path reported during install (handles subdirectories and
 *      worktrees with arbitrary directory names)
 *   2. Walk up cwd — try owner/name then name at every directory level
 *   3. Project slug fallback — check if slug ends with a repo name
 */
export async function matchSessionRepo(
  db: Database,
  userId: number,
  cwdOrNull: string | null,
  project: string,
  deviceId?: number | null,
): Promise<number | null> {
  if (!cwdOrNull && !project) return null;

  // Strategy 1: device_repo_paths (most accurate, handles subdirs/worktrees)
  if (deviceId && (cwdOrNull || project)) {
    const paths = await db
      .select({ repoId: deviceRepoPaths.repoId, localPath: deviceRepoPaths.localPath })
      .from(deviceRepoPaths)
      .where(eq(deviceRepoPaths.deviceId, deviceId));

    // Longest-prefix match so the most specific repo root wins.
    const sorted = paths.sort((a, b) => b.localPath.length - a.localPath.length);
    for (const p of sorted) {
      const slug = toProjectSlug(p.localPath);
      const cwd = cwdOrNull;
      const matchesCwd = cwd ? cwd === p.localPath || cwd.startsWith(p.localPath + "/") : false;
      const matchesProject =
        Boolean(project) && (project === slug || project.startsWith(`${slug}-`));

      if (matchesCwd || matchesProject) {
        return await acceptRepoCandidate(db, deviceId, p.repoId);
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

  const projectLower = normalizeFullName(project);

  // Strategy 2: walk UP the cwd path, trying owner/name then name at each level
  if (cwdOrNull) {
    const parts = normalizeFullName(cwdOrNull).split("/").filter(Boolean);
    for (let i = parts.length; i >= 1; i--) {
      const dirName = parts[i - 1];
      if (i >= 2) {
        const ownerRepo = `${parts[i - 2]}/${dirName}`;
        const match = userRepoRows.find((r) => r.fullName === ownerRepo);
        if (match) return await acceptRepoCandidate(db, deviceId, match.repoId);
      }
      const match = userRepoRows.find((r) => r.name === dirName);
      if (match) return await acceptRepoCandidate(db, deviceId, match.repoId);
    }
  }

  // Strategy 3: project slug fallback
  for (const row of userRepoRows) {
    if (projectLower.endsWith(row.name) || projectLower.endsWith(`-${row.name}`)) {
      return await acceptRepoCandidate(db, deviceId, row.repoId);
    }
  }

  return null;
}
