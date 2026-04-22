/**
 * Sync repos from GitHub API → repos + user_repos tables.
 */

import { eq, and, notInArray } from "drizzle-orm";
import type { Database } from "../db";
import { repos, userRepos, users, deviceRepoPaths } from "../db/schema";
import { config } from "../config";
import { decryptGithubToken } from "../auth/tokens";

interface GithubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  owner: { login: string };
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean };
}

export async function syncUserRepos(
  db: Database,
  user: { id: number; githubToken: string }
): Promise<{ synced: number; removed: number }> {
  // Decrypt the stored GitHub token
  const token = await decryptGithubToken(user.githubToken, config.encryptionKey);

  // Paginate through all repos
  const allRepos: GithubRepo[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=100&type=all&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) break;
    const batch = (await res.json()) as GithubRepo[];
    if (batch.length === 0) break;
    allRepos.push(...batch);
    page++;
  }

  // Filter to repos where user has push permission
  const pushRepos = allRepos.filter((r) => r.permissions?.push);

  // Upsert repos
  const syncedRepoIds: number[] = [];
  for (const ghRepo of pushRepos) {
    const [repo] = await db
      .insert(repos)
      .values({
        githubId: ghRepo.id,
        fullName: ghRepo.full_name,
        owner: ghRepo.owner.login,
        name: ghRepo.name,
        private: ghRepo.private,
      })
      .onConflictDoUpdate({
        target: repos.githubId,
        set: {
          fullName: ghRepo.full_name,
          owner: ghRepo.owner.login,
          name: ghRepo.name,
          private: ghRepo.private,
        },
      })
      .returning({ id: repos.id });
    syncedRepoIds.push(repo.id);

    // Determine permission level
    const permission = ghRepo.permissions?.admin
      ? "admin"
      : ghRepo.permissions?.maintain
        ? "maintain"
        : "push";

    // Upsert user_repos
    await db
      .insert(userRepos)
      .values({
        userId: user.id,
        repoId: repo.id,
        permission,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userRepos.userId, userRepos.repoId],
        set: { permission, syncedAt: new Date() },
      });
  }

  // Remove stale user_repos (repos user no longer has access to)
  let removed = 0;
  if (syncedRepoIds.length > 0) {
    const stale = await db
      .delete(userRepos)
      .where(
        and(
          eq(userRepos.userId, user.id),
          notInArray(userRepos.repoId, syncedRepoIds)
        )
      )
      .returning();
    removed = stale.length;
  } else {
    // User has no push repos — remove all
    const stale = await db
      .delete(userRepos)
      .where(eq(userRepos.userId, user.id))
      .returning();
    removed = stale.length;
  }

  return { synced: syncedRepoIds.length, removed };
}

/**
 * Try to match a session's cwd/project to a known repo.
 *
 * Strategy (most specific first):
 *   1. Device repo paths — check if cwd is inside a known local clone path
 *      reported during install (handles subdirectories)
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
    // Start from the full path and walk toward root
    for (let i = parts.length; i >= 1; i--) {
      const dirName = parts[i - 1];
      // Try owner/name (e.g. "shared-org/repo-common")
      if (i >= 2) {
        const ownerRepo = `${parts[i - 2]}/${dirName}`;
        const match = userRepoRows.find((r) => r.fullName === ownerRepo);
        if (match) return match.repoId;
      }
      // Try name-only
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
