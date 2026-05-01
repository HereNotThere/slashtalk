import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ChatHistoryTurn, ChatThread } from "@slashtalk/shared";
import type { Database } from "../db";
import { chatMessages } from "../db/schema";
import { loadSessionCards } from "./cards";

const MAX_THREADS_DEFAULT = 50;

interface AskerInfo {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface LoadHistoryParams {
  /** The viewer (used for citation visibility — they only see cards in their user_repos). */
  viewerId: number;
  /** Whose threads to load. Equals viewerId for "my history"; differs for peer-feed views. */
  authorId: number;
  /** Pre-resolved asker identity so callers can skip an extra users lookup. */
  asker: AskerInfo;
  limit?: number;
}

/** Load the most recent threads authored by `authorId`, hydrating SessionCards
 *  using the viewer's repo visibility. Turn citations are filtered to the same
 *  visible session ids as the cards so hidden session ids do not leak. */
export async function loadChatHistory(
  db: Database,
  params: LoadHistoryParams,
): Promise<ChatThread[]> {
  const limit = params.limit ?? MAX_THREADS_DEFAULT;

  const threadHeaders = await db
    .select({
      threadId: chatMessages.threadId,
      firstTs: sql<string>`min(${chatMessages.createdAt})`.as("first_ts"),
      lastTs: sql<string>`max(${chatMessages.createdAt})`.as("last_ts"),
    })
    .from(chatMessages)
    .where(eq(chatMessages.userId, params.authorId))
    .groupBy(chatMessages.threadId)
    .orderBy(desc(sql`max(${chatMessages.createdAt})`))
    .limit(limit);

  if (threadHeaders.length === 0) return [];

  const threadIds = threadHeaders.map((h) => h.threadId);
  const turnRows = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, params.authorId), inArray(chatMessages.threadId, threadIds)))
    .orderBy(chatMessages.threadId, chatMessages.turnIndex);

  const turnsByThread = new Map<string, ChatHistoryTurn[]>();
  const citationIdsByThread = new Map<string, string[]>();
  for (const row of turnRows) {
    const turn: ChatHistoryTurn = {
      id: row.id,
      turnIndex: row.turnIndex,
      prompt: row.prompt,
      answer: row.answer,
      citations: row.citations,
      createdAt: (row.createdAt ?? new Date()).toISOString(),
    };
    const existing = turnsByThread.get(row.threadId);
    if (existing) existing.push(turn);
    else turnsByThread.set(row.threadId, [turn]);

    const citIds = citationIdsByThread.get(row.threadId) ?? [];
    for (const c of row.citations) citIds.push(c.sessionId);
    citationIdsByThread.set(row.threadId, citIds);
  }

  // One batched card hydration across all threads — loadSessionCards already
  // gates on the viewer's user_repos and dedupes, so we just split results
  // back into per-thread buckets afterwards.
  const allCitationIds = [...new Set(turnRows.flatMap((r) => r.citations.map((c) => c.sessionId)))];
  const allCards = await loadSessionCards(db, params.viewerId, allCitationIds);
  const cardById = new Map(allCards.map((c) => [c.id, c]));

  const out: ChatThread[] = [];
  for (const header of threadHeaders) {
    const turns = turnsByThread.get(header.threadId) ?? [];
    if (turns.length === 0) continue;
    const firstPrompt = turns[0].prompt;
    const seen = new Set<string>();
    const cards = (citationIdsByThread.get(header.threadId) ?? [])
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => cardById.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    const visibleCitationIds = new Set(cards.map((c) => c.id));
    const visibleTurns = turns.map((turn) => ({
      ...turn,
      citations: turn.citations.filter((citation) => visibleCitationIds.has(citation.sessionId)),
    }));

    out.push({
      threadId: header.threadId,
      asker: params.asker,
      title: firstPrompt,
      turns: visibleTurns,
      cards,
      createdAt: new Date(header.firstTs).toISOString(),
      updatedAt: new Date(header.lastTs).toISOString(),
    });
  }
  return out;
}
