import { inArray } from "drizzle-orm";
import type { Database } from "../db";
import { heartbeats, repos, sessions, users } from "../db/schema";
import { loadInsightsForSessions, loadPrsForSessions, toSnapshot } from "./snapshot";

type SessionRow = typeof sessions.$inferSelect;
type SessionSnapshot = ReturnType<typeof toSnapshot>;

export interface SessionReadUser {
  id: number;
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface SessionReadRepo {
  id: number;
  fullName: string;
}

export interface HydratedSession {
  row: SessionRow;
  snapshot: SessionSnapshot;
  user: SessionReadUser | null;
  repo: SessionReadRepo | null;
}

export interface HydrateSessionsOptions {
  includeUsers?: boolean;
  includeRepos?: boolean;
  includePrs?: boolean;
}

export async function hydrateSessions(
  db: Database,
  rows: SessionRow[],
  options: HydrateSessionsOptions = {},
): Promise<HydratedSession[]> {
  const sessionIds = rows.map((s) => s.sessionId);
  const repoIds = [...new Set(rows.map((s) => s.repoId).filter((id): id is number => id !== null))];
  const userIds = [...new Set(rows.map((s) => s.userId))];

  const includePrs = options.includePrs ?? true;
  const [hbRows, insightsMap, prMap, userRows, repoRows] = await Promise.all([
    sessionIds.length > 0
      ? db.select().from(heartbeats).where(inArray(heartbeats.sessionId, sessionIds))
      : Promise.resolve([]),
    loadInsightsForSessions(db, sessionIds),
    includePrs
      ? loadPrsForSessions(
          db,
          rows.map((s) => ({
            sessionId: s.sessionId,
            repoId: s.repoId,
            branch: s.branch,
          })),
        )
      : Promise.resolve(new Map()),
    options.includeUsers && userIds.length > 0
      ? db
          .select({
            id: users.id,
            githubLogin: users.githubLogin,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    options.includeRepos && repoIds.length > 0
      ? db
          .select({ id: repos.id, fullName: repos.fullName })
          .from(repos)
          .where(inArray(repos.id, repoIds))
      : Promise.resolve([]),
  ]);

  const hbMap = new Map(hbRows.map((h) => [h.sessionId, h]));
  const userMap = new Map(userRows.map((u) => [u.id, u]));
  const repoMap = new Map(repoRows.map((r) => [r.id, r]));

  return rows.map((row) => ({
    row,
    snapshot: toSnapshot(
      row,
      hbMap.get(row.sessionId) ?? null,
      insightsMap.get(row.sessionId) ?? null,
      prMap.get(row.sessionId) ?? null,
    ),
    user: userMap.get(row.userId) ?? null,
    repo: row.repoId ? (repoMap.get(row.repoId) ?? null) : null,
  }));
}

export async function hydrateSession(
  db: Database,
  row: SessionRow,
  options: HydrateSessionsOptions = {},
): Promise<HydratedSession> {
  const [hydrated] = await hydrateSessions(db, [row], options);
  return hydrated;
}
