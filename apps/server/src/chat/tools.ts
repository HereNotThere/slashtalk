import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, users, repos, userRepos, heartbeats } from "../db/schema";
import { loadInsightsForSessions, toSnapshot } from "../sessions/snapshot";
import type { SessionState } from "@slashtalk/shared";

export interface TeamActivitySessionSummary {
  id: string;
  title: string | null;
  description: string | null;
  state: SessionState;
  repo: string | null;
  branch: string | null;
  lastTs: string | null;
  currentTool: string | null;
  lastUserPrompt: string | null;
}

export interface TeamActivityTeammate {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isSelf: boolean;
  sessions: TeamActivitySessionSummary[];
}

export interface TeamActivityResult {
  teammates: TeamActivityTeammate[];
  /** Inclusive window start, ISO8601 */
  since: string;
}

export interface GetTeamActivityArgs {
  sinceHours?: number;
  state?: SessionState;
}

const SESSIONS_PER_USER_CAP = 3;

/**
 * Per-teammate roll-up of recent sessions across repos the caller can see.
 * Scoped strictly to the caller's `user_repos` set — no cross-team leakage.
 * Returns the caller too (flagged `isSelf`) so "what am I doing" works.
 */
export async function getTeamActivityImpl(
  db: Database,
  userId: number,
  args: GetTeamActivityArgs,
): Promise<TeamActivityResult> {
  const sinceHours = args.sinceHours ?? 24;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

  const myRepoRows = await db
    .select({ id: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));
  const myRepoIds = myRepoRows.map((r) => r.id);
  if (myRepoIds.length === 0) {
    return { teammates: [], since: since.toISOString() };
  }

  const peerRows = await db
    .selectDistinct({ userId: userRepos.userId })
    .from(userRepos)
    .where(inArray(userRepos.repoId, myRepoIds));
  const peerIds = peerRows.map((r) => r.userId);
  if (peerIds.length === 0) {
    return { teammates: [], since: since.toISOString() };
  }

  const sessionRows = await db
    .select()
    .from(sessions)
    .where(
      and(
        inArray(sessions.userId, peerIds),
        inArray(sessions.repoId, myRepoIds),
        gt(sessions.lastTs, since),
      ),
    )
    .orderBy(sql`${sessions.lastTs} desc nulls last`)
    .limit(200);
  const sessionIds = sessionRows.map((s) => s.sessionId);
  const repoIdsInUse = [
    ...new Set(sessionRows.map((s) => s.repoId).filter((id): id is number => id !== null)),
  ];

  const [hbRows, userRows, repoRows, insightsMap] = await Promise.all([
    sessionIds.length
      ? db.select().from(heartbeats).where(inArray(heartbeats.sessionId, sessionIds))
      : Promise.resolve([]),
    db
      .select({
        id: users.id,
        login: users.githubLogin,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, peerIds)),
    repoIdsInUse.length
      ? db
          .select({ id: repos.id, fullName: repos.fullName })
          .from(repos)
          .where(inArray(repos.id, repoIdsInUse))
      : Promise.resolve([]),
    loadInsightsForSessions(db, sessionIds),
  ]);
  const hbMap = new Map(hbRows.map((h) => [h.sessionId, h]));
  const userMap = new Map(userRows.map((u) => [u.id, u]));
  const repoMap = new Map(repoRows.map((r) => [r.id, r]));

  // sessionRows is already ordered `lastTs desc nulls last`, so the first
  // time a user's id appears is their most recent session — we rely on that
  // to sort teammates without a second sort pass.
  const byUser = new Map<number, TeamActivitySessionSummary[]>();
  for (const s of sessionRows) {
    const snapshot = toSnapshot(
      s,
      hbMap.get(s.sessionId) ?? null,
      insightsMap.get(s.sessionId) ?? null,
    );
    if (args.state && snapshot.state !== args.state) continue;
    const arr = byUser.get(s.userId) ?? [];
    if (arr.length >= SESSIONS_PER_USER_CAP) continue;
    arr.push({
      id: snapshot.id,
      title: snapshot.title,
      description: snapshot.description,
      state: snapshot.state,
      repo: s.repoId ? (repoMap.get(s.repoId)?.fullName ?? null) : null,
      branch: snapshot.branch,
      lastTs: snapshot.lastTs,
      currentTool: snapshot.currentTool?.name ?? null,
      lastUserPrompt: snapshot.lastUserPrompt,
    });
    byUser.set(s.userId, arr);
  }

  const teammates: TeamActivityTeammate[] = [...byUser.entries()].map(
    ([uid, sess]) => {
      const u = userMap.get(uid);
      return {
        login: u?.login ?? "unknown",
        name: u?.displayName ?? null,
        avatarUrl: u?.avatarUrl ?? null,
        isSelf: uid === userId,
        sessions: sess,
      };
    },
  );

  return { teammates, since: since.toISOString() };
}

export interface GetSessionArgs {
  sessionId: string;
}

export type GetSessionResult =
  | { kind: "ok"; session: ReturnType<typeof toSnapshot> & {
      user: { login: string; name: string | null } | null;
      repo: string | null;
    } }
  | { kind: "error"; message: string };

export async function getSessionImpl(
  db: Database,
  userId: number,
  args: GetSessionArgs,
): Promise<GetSessionResult> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, args.sessionId))
    .limit(1);
  if (!row) return { kind: "error", message: "session not found" };
  if (!row.repoId) {
    return { kind: "error", message: "session not matched to a repo" };
  }

  const [access] = await db
    .select({ id: userRepos.repoId })
    .from(userRepos)
    .where(and(eq(userRepos.userId, userId), eq(userRepos.repoId, row.repoId)))
    .limit(1);
  if (!access) {
    return { kind: "error", message: "session not visible to caller" };
  }

  const [hbRows, insightsMap, userRows, repoRows] = await Promise.all([
    db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.sessionId, args.sessionId))
      .limit(1),
    loadInsightsForSessions(db, [args.sessionId]),
    db
      .select({ login: users.githubLogin, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1),
    db
      .select({ fullName: repos.fullName })
      .from(repos)
      .where(eq(repos.id, row.repoId))
      .limit(1),
  ]);
  const snapshot = toSnapshot(
    row,
    hbRows[0] ?? null,
    insightsMap.get(args.sessionId) ?? null,
  );
  const u = userRows[0];
  const r = repoRows[0];

  return {
    kind: "ok",
    session: {
      ...snapshot,
      user: u ? { login: u.login, name: u.displayName ?? null } : null,
      repo: r?.fullName ?? null,
    },
  };
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (input: Record<string, unknown>) => Promise<{
    content: string;
    isError?: boolean;
  }>;
}

export function buildChatTools(
  db: Database,
  userId: number,
): ChatToolDefinition[] {
  return [
    {
      name: "get_team_activity",
      description:
        "Per-teammate roll-up of recent Claude Code sessions across repos you share with your team. Call this first for open-ended questions about what the team is working on. Returns teammates (including yourself) with up to 3 recent sessions each.",
      input_schema: {
        type: "object",
        properties: {
          sinceHours: {
            type: "integer",
            minimum: 1,
            maximum: 168,
            description: "Lookback window in hours; default 24",
          },
          state: {
            type: "string",
            enum: ["busy", "active", "idle", "recent"],
            description: "Filter to a single session state",
          },
        },
      },
      handler: async (input) => {
        const result = await getTeamActivityImpl(
          db,
          userId,
          input as GetTeamActivityArgs,
        );
        return { content: JSON.stringify(result) };
      },
    },
    {
      name: "get_session",
      description:
        "Full detail on one session: rolling summary, highlights, recent events, top files, current tool. Use after get_team_activity to go deep on a specific session.",
      input_schema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session UUID" },
        },
        required: ["sessionId"],
      },
      handler: async (input) => {
        const result = await getSessionImpl(
          db,
          userId,
          input as unknown as GetSessionArgs,
        );
        if (result.kind === "error") {
          return { content: result.message, isError: true };
        }
        return { content: JSON.stringify(result.session) };
      },
    },
  ];
}
