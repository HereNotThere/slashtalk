import { eq, inArray } from "drizzle-orm";
import type { SessionCard } from "@slashtalk/shared";
import type { Database } from "../db";
import { heartbeats, repos, sessions, userRepos, users } from "../db/schema";
import { loadInsightsForSessions, toSnapshot } from "../sessions/snapshot";

const CARD_LAST_PROMPT_MAX_CHARS = 240;

function truncate(s: string | null, max: number): string | null {
  if (!s) return s;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Hydrate compact cards for a batch of session IDs the assistant cited.
 * Rules:
 *   - Preserves input order, de-duped.
 *   - Drops any session the caller can't see (not on a repo in user_repos).
 *   - Skips unknown IDs silently — the model may hallucinate, never crash on it.
 */
export async function loadSessionCards(
  db: Database,
  callerId: number,
  sessionIds: string[],
  cachedVisibleRepoIds?: number[],
): Promise<SessionCard[]> {
  const orderedUnique = [...new Set(sessionIds)];
  if (orderedUnique.length === 0) return [];

  const [sessionRows, visibleRepoIds] = await Promise.all([
    db.select().from(sessions).where(inArray(sessions.sessionId, orderedUnique)),
    cachedVisibleRepoIds
      ? Promise.resolve(new Set(cachedVisibleRepoIds))
      : db
          .select({ id: userRepos.repoId })
          .from(userRepos)
          .where(eq(userRepos.userId, callerId))
          .then((rows) => new Set(rows.map((r) => r.id))),
  ]);

  const visible = sessionRows.filter((r) => r.repoId !== null && visibleRepoIds.has(r.repoId));
  if (visible.length === 0) return [];

  const visibleIds = visible.map((s) => s.sessionId);
  const userIds = [...new Set(visible.map((s) => s.userId))];
  // `visible` is already filtered to rows with non-null repoId, so the `!` is safe.
  const repoIds = [...new Set(visible.map((s) => s.repoId!))];

  const [hbRows, userRows, repoRows, insightsMap] = await Promise.all([
    db.select().from(heartbeats).where(inArray(heartbeats.sessionId, visibleIds)),
    db
      .select({
        id: users.id,
        login: users.githubLogin,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, userIds)),
    db
      .select({ id: repos.id, fullName: repos.fullName })
      .from(repos)
      .where(inArray(repos.id, repoIds)),
    loadInsightsForSessions(db, visibleIds),
  ]);

  const hbMap = new Map(hbRows.map((h) => [h.sessionId, h]));
  const userMap = new Map(userRows.map((u) => [u.id, u]));
  const repoMap = new Map(repoRows.map((r) => [r.id, r]));
  const byId = new Map(visible.map((s) => [s.sessionId, s]));

  const cards: SessionCard[] = [];
  for (const id of orderedUnique) {
    const row = byId.get(id);
    if (!row) continue;
    const snapshot = toSnapshot(
      row,
      hbMap.get(row.sessionId) ?? null,
      insightsMap.get(row.sessionId) ?? null,
    );
    const u = userMap.get(row.userId);
    const r = row.repoId ? repoMap.get(row.repoId) : null;
    cards.push({
      id: snapshot.id,
      user: {
        login: u?.login ?? "unknown",
        displayName: u?.displayName ?? null,
        avatarUrl: u?.avatarUrl ?? null,
      },
      title: snapshot.title,
      state: snapshot.state,
      repo: r?.fullName ?? null,
      branch: snapshot.branch,
      lastTs: snapshot.lastTs,
      currentTool: snapshot.currentTool?.name ?? null,
      lastUserPrompt: truncate(snapshot.lastUserPrompt, CARD_LAST_PROMPT_MAX_CHARS),
      source: row.source,
    });
  }
  return cards;
}

/**
 * Backstop cap on hydration. Visible cap at the UI layer is lower (5);
 * this prevents a pathological citation flood from fanning out.
 */
export const MAX_CARDS_PER_MESSAGE = 12;
