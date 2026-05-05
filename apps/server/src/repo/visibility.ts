import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { repos, sessions, userRepos } from "../db/schema";

export type VisibleRepo = {
  id: number;
  fullName: string;
};

export async function visibleRepoIdsForUser(db: Database, userId: number): Promise<number[]> {
  const rows = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));
  return rows.map((row) => row.repoId);
}

export async function visibleReposForUser(db: Database, userId: number): Promise<VisibleRepo[]> {
  const rows = await db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(userRepos)
    .innerJoin(repos, eq(repos.id, userRepos.repoId))
    .where(eq(userRepos.userId, userId));
  return rows;
}

export async function sharedRepoIdsForUsers(
  db: Database,
  callerId: number,
  targetId: number,
): Promise<number[]> {
  if (callerId === targetId) return visibleRepoIdsForUser(db, callerId);

  const callerRepoIds = db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, callerId));

  const rows = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(and(eq(userRepos.userId, targetId), inArray(userRepos.repoId, callerRepoIds)));
  return rows.map((row) => row.repoId);
}

export async function visiblePeerIdsForUser(
  db: Database,
  userId: number,
  options: { includeSelf?: boolean } = {},
): Promise<number[]> {
  const repoIds = db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));

  const rows = await db
    .selectDistinct({ userId: userRepos.userId })
    .from(userRepos)
    .where(inArray(userRepos.repoId, repoIds));

  const ids = rows.map((row) => row.userId);
  if (options.includeSelf) return [...new Set([userId, ...ids])];
  return ids.filter((id) => id !== userId);
}

export async function visibleUserIdsForRepoIds(db: Database, repoIds: number[]): Promise<number[]> {
  if (repoIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ userId: userRepos.userId })
    .from(userRepos)
    .where(inArray(userRepos.repoId, repoIds));
  return rows.map((row) => row.userId);
}

export async function canReadRepo(db: Database, userId: number, repoId: number): Promise<boolean> {
  const [access] = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(and(eq(userRepos.userId, userId), eq(userRepos.repoId, repoId)))
    .limit(1);
  return !!access;
}

export async function loadAccessibleSession(
  db: Database,
  sessionId: string,
  userId: number,
): Promise<typeof sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);

  if (!session) return null;
  if (session.userId === userId) return session;
  if (!session.repoId) return null;

  return (await canReadRepo(db, userId, session.repoId)) ? session : null;
}
