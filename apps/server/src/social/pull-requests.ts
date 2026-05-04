import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { ProjectPr, SessionPr, UserPr } from "@slashtalk/shared";
import type { Database } from "../db";
import { pullRequests, repos, users } from "../db/schema";

export interface PullRequestUpsert {
  repoId: number;
  number: number;
  headRef: string;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  authorLogin: string;
  updatedAt: Date;
}

export interface UpsertPullRequestsOptions {
  preserveHeadRef?: boolean;
}

export interface UserPullRequestRow {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  updatedAt: Date | null;
  repoFullName: string;
}

export async function upsertPullRequests(
  db: Database,
  rows: PullRequestUpsert[],
  options: UpsertPullRequestsOptions = {},
): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insert(pullRequests)
    .values(rows)
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.number],
      set: {
        ...(options.preserveHeadRef ? {} : { headRef: sql`excluded.head_ref` }),
        title: sql`excluded.title`,
        url: sql`excluded.url`,
        state: sql`excluded.state`,
        authorLogin: sql`excluded.author_login`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/**
 * Batch-load PRs matching (repo_id, branch) for a set of sessions. Returns a
 * map keyed by session_id → PR (or undefined when no match). "No match" is
 * common and not an error: the poller's coverage is best-effort.
 *
 * When multiple PRs share a (repo_id, head_ref) we pick the most recent by
 * `updated_at`. In practice GitHub only allows one open PR per head ref, so
 * duplicates only happen across open+closed/merged history.
 */
export async function loadPrsForSessions(
  db: Database,
  rows: { sessionId: string; repoId: number | null; branch: string | null }[],
): Promise<Map<string, SessionPr>> {
  const result = new Map<string, SessionPr>();
  const eligible = rows.filter(
    (r): r is { sessionId: string; repoId: number; branch: string } =>
      r.repoId != null && !!r.branch,
  );
  if (eligible.length === 0) return result;

  const uniquePairs = new Map<string, { repoId: number; headRef: string }>();
  for (const r of eligible) {
    uniquePairs.set(`${r.repoId}:${r.branch}`, {
      repoId: r.repoId,
      headRef: r.branch,
    });
  }

  const conditions = [...uniquePairs.values()].map((p) =>
    and(eq(pullRequests.repoId, p.repoId), eq(pullRequests.headRef, p.headRef)),
  );
  const prRows = await db
    .select({
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      headRef: pullRequests.headRef,
      title: pullRequests.title,
      url: pullRequests.url,
      state: pullRequests.state,
      authorLogin: pullRequests.authorLogin,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequests)
    .where(or(...conditions))
    .orderBy(sql`${pullRequests.updatedAt} desc nulls last`);

  const byPair = new Map<string, (typeof prRows)[number]>();
  for (const pr of prRows) {
    const k = `${pr.repoId}:${pr.headRef}`;
    if (!byPair.has(k)) byPair.set(k, pr);
  }

  for (const r of eligible) {
    const pr = byPair.get(`${r.repoId}:${r.branch}`);
    if (!pr) continue;
    result.set(r.sessionId, {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      authorLogin: pr.authorLogin,
    });
  }
  return result;
}

export async function loadProjectPullRequests(
  db: Database,
  repoId: number,
  since: Date,
  limit: number,
): Promise<ProjectPr[]> {
  const sinceIso = since.toISOString();
  const rows = await db
    .select({
      number: pullRequests.number,
      title: pullRequests.title,
      url: pullRequests.url,
      state: pullRequests.state,
      authorLogin: pullRequests.authorLogin,
      updatedAt: pullRequests.updatedAt,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(pullRequests)
    .leftJoin(users, eq(users.githubLogin, pullRequests.authorLogin))
    .where(and(eq(pullRequests.repoId, repoId), gte(pullRequests.updatedAt, since)))
    .orderBy(desc(pullRequests.updatedAt))
    .limit(limit);

  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    url: r.url,
    state: r.state,
    authorLogin: r.authorLogin,
    authorAvatarUrl: r.authorAvatarUrl ?? null,
    updatedAt: r.updatedAt?.toISOString() ?? sinceIso,
  }));
}

export async function loadUserPullRequests(
  db: Database,
  args: {
    authorLogin: string;
    repoIds: number[];
    since: Date;
  },
): Promise<UserPr[]> {
  const rows = await loadUserPullRequestRows(db, args);
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    url: r.url,
    state: r.state,
    repoFullName: r.repoFullName,
    updatedAt: r.updatedAt?.toISOString() ?? new Date().toISOString(),
  }));
}

export async function loadUserPullRequestRows(
  db: Database,
  args: {
    authorLogin: string;
    repoIds: number[];
    since: Date;
    limit?: number;
  },
): Promise<UserPullRequestRow[]> {
  if (args.repoIds.length === 0) return [];

  const query = db
    .select({
      number: pullRequests.number,
      title: pullRequests.title,
      url: pullRequests.url,
      state: pullRequests.state,
      updatedAt: pullRequests.updatedAt,
      repoFullName: repos.fullName,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        inArray(pullRequests.repoId, args.repoIds),
        eq(pullRequests.authorLogin, args.authorLogin),
        gte(pullRequests.updatedAt, args.since),
      ),
    )
    .orderBy(desc(pullRequests.updatedAt))
    .$dynamic();

  return args.limit ? query.limit(args.limit) : query;
}
