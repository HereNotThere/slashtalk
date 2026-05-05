import { inArray } from "drizzle-orm";
import type { SessionCard } from "@slashtalk/shared";
import type { Database } from "../db";
import { sessions } from "../db/schema";
import { visibleRepoIdsForUser } from "../repo/visibility";
import { hydrateSessions } from "../sessions/read-model";
import { truncateWithEllipsis } from "../util/text";

const CARD_LAST_PROMPT_MAX_CHARS = 240;

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
      : visibleRepoIdsForUser(db, callerId).then((ids) => new Set(ids)),
  ]);

  const visible = sessionRows.filter((r) => r.repoId !== null && visibleRepoIds.has(r.repoId));
  if (visible.length === 0) return [];

  const hydrated = await hydrateSessions(db, visible, {
    includeUsers: true,
    includeRepos: true,
    includePrs: false,
  });
  const byId = new Map(hydrated.map((s) => [s.row.sessionId, s]));

  const cards: SessionCard[] = [];
  for (const id of orderedUnique) {
    const hydratedSession = byId.get(id);
    if (!hydratedSession) continue;
    const { row, snapshot, user: u, repo: r } = hydratedSession;
    cards.push({
      id: snapshot.id,
      user: {
        login: u?.githubLogin ?? "unknown",
        displayName: u?.displayName ?? null,
        avatarUrl: u?.avatarUrl ?? null,
      },
      title: snapshot.title,
      state: snapshot.state,
      repo: r?.fullName ?? null,
      branch: snapshot.branch,
      lastTs: snapshot.lastTs,
      currentTool: snapshot.currentTool?.name ?? null,
      lastUserPrompt: truncateWithEllipsis(snapshot.lastUserPrompt, CARD_LAST_PROMPT_MAX_CHARS),
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
