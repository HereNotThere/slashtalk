import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, userRepos } from "../db/schema";

type SessionRow = typeof sessions.$inferSelect;

/**
 * Loads a session by id and returns it iff the caller owns it or has access
 * via `user_repos` (CLAUDE.md rule #13: `user_repos` is the only authorization
 * for cross-user reads).
 *
 * Returns null when the session doesn't exist OR the caller has no access.
 * Callers should treat both as 404 — surfacing "exists but forbidden" would
 * leak the existence of sessions in repos the caller can't see.
 */
export async function loadAccessibleSession(
  db: Database,
  sessionId: string,
  userId: number,
): Promise<SessionRow | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);

  if (!session) return null;
  if (session.userId === userId) return session;
  if (!session.repoId) return null;

  const [access] = await db
    .select()
    .from(userRepos)
    .where(and(eq(userRepos.userId, userId), eq(userRepos.repoId, session.repoId)))
    .limit(1);

  return access ? session : null;
}
