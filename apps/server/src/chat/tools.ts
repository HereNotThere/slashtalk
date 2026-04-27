import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, users, repos, userRepos, heartbeats } from "../db/schema";
import { loadInsightsForSessions, toSnapshot } from "../sessions/snapshot";
import type { EventSource, SessionState } from "@slashtalk/shared";
import { normalizeFullName } from "../social/github-sync";
import { isCollisionIgnoredPath } from "../correlate/file-index";

export interface TeamActivitySessionSummary {
  id: string;
  title: string | null;
  description: string | null;
  state: SessionState;
  source: EventSource;
  repo: string | null;
  branch: string | null;
  lastTs: string | null;
  currentTool: string | null;
  lastUserPrompt: string | null;
  topFilesEdited: string[];
  toolErrors: number;
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
  since?: string;
  state?: SessionState;
  login?: string;
  repoFullName?: string;
  filePath?: string;
}

const SESSIONS_PER_USER_CAP = 3;
const LAST_PROMPT_MAX_CHARS = 240;
const TOP_FILES_IN_ROLLUP = 3;
const DEFAULT_LOOKBACK_HOURS = 48;
const MAX_LOOKBACK_HOURS = 168;

export interface ChatToolContext {
  /** Caller's visible repo IDs, if the runner already fetched them. Skips
   *  a per-request DB round-trip when provided. */
  visibleRepoIds?: number[];
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return s;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Per-teammate roll-up of recent sessions across repos the caller can see.
 * Scoped strictly to the caller's `user_repos` set — no cross-team leakage.
 * Returns the caller too (flagged `isSelf`) so "what am I doing" works.
 */
export async function getTeamActivityImpl(
  db: Database,
  userId: number,
  args: GetTeamActivityArgs,
  ctx?: ChatToolContext,
): Promise<TeamActivityResult> {
  const since = resolveSince(args);

  // Lockfiles and similar high-traffic basenames are not conflict-worthy —
  // share the ignore list with the live collision index in `correlate/`.
  if (args.filePath && isCollisionIgnoredPath(args.filePath)) {
    return { teammates: [], since: since.toISOString() };
  }

  let repoIdScope: number[];
  if (ctx?.visibleRepoIds) {
    repoIdScope = ctx.visibleRepoIds;
  } else {
    const myRepoRows = await db
      .select({ id: userRepos.repoId })
      .from(userRepos)
      .where(eq(userRepos.userId, userId));
    repoIdScope = myRepoRows.map((r) => r.id);
  }
  if (repoIdScope.length === 0) {
    return { teammates: [], since: since.toISOString() };
  }

  if (args.repoFullName) {
    const [repoRow] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.fullName, normalizeFullName(args.repoFullName)))
      .limit(1);
    if (!repoRow || !repoIdScope.includes(repoRow.id)) {
      return { teammates: [], since: since.toISOString() };
    }
    repoIdScope = [repoRow.id];
  }

  let userIdScope: number[];
  if (args.login) {
    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.githubLogin, args.login))
      .limit(1);
    if (!userRow) {
      return { teammates: [], since: since.toISOString() };
    }
    userIdScope = [userRow.id];
  } else {
    const peerRows = await db
      .selectDistinct({ userId: userRepos.userId })
      .from(userRepos)
      .where(inArray(userRepos.repoId, repoIdScope));
    userIdScope = peerRows.map((r) => r.userId);
  }
  if (userIdScope.length === 0) {
    return { teammates: [], since: since.toISOString() };
  }

  const sessionRows = await db
    .select()
    .from(sessions)
    .where(
      and(
        inArray(sessions.userId, userIdScope),
        inArray(sessions.repoId, repoIdScope),
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
      .where(inArray(users.id, userIdScope)),
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
    if (args.filePath) {
      const editedPaths = snapshot.topFilesEdited.map(([p]) => p);
      if (!editedPaths.some((p) => pathMatches(p, args.filePath!))) continue;
    }
    const arr = byUser.get(s.userId) ?? [];
    if (arr.length >= SESSIONS_PER_USER_CAP) continue;
    arr.push({
      id: snapshot.id,
      title: snapshot.title,
      description: snapshot.description,
      state: snapshot.state,
      source: s.source,
      repo: s.repoId ? (repoMap.get(s.repoId)?.fullName ?? null) : null,
      branch: snapshot.branch,
      lastTs: snapshot.lastTs,
      currentTool: snapshot.currentTool?.name ?? null,
      lastUserPrompt: truncate(snapshot.lastUserPrompt, LAST_PROMPT_MAX_CHARS),
      topFilesEdited: snapshot.topFilesEdited.slice(0, TOP_FILES_IN_ROLLUP).map(([path]) => path),
      toolErrors: snapshot.toolErrors,
    });
    byUser.set(s.userId, arr);
  }

  const teammates: TeamActivityTeammate[] = [...byUser.entries()].map(([uid, sess]) => {
    const u = userMap.get(uid);
    return {
      login: u?.login ?? "unknown",
      name: u?.displayName ?? null,
      avatarUrl: u?.avatarUrl ?? null,
      isSelf: uid === userId,
      sessions: sess,
    };
  });

  // For conflict-detection lookups, the caller is the one editing the file —
  // surfacing themselves as overlap is noise.
  const finalTeammates = args.filePath ? teammates.filter((t) => !t.isSelf) : teammates;
  return { teammates: finalTeammates, since: since.toISOString() };
}

function pathMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/" + b)) return true;
  if (b.endsWith("/" + a)) return true;
  return false;
}

export interface GetSessionArgs {
  sessionId: string;
}

export type GetSessionResult =
  | {
      kind: "ok";
      session: ReturnType<typeof toSnapshot> & {
        user: { login: string; name: string | null } | null;
        repo: string | null;
      };
    }
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
    db.select().from(heartbeats).where(eq(heartbeats.sessionId, args.sessionId)).limit(1),
    loadInsightsForSessions(db, [args.sessionId]),
    db
      .select({ login: users.githubLogin, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1),
    db.select({ fullName: repos.fullName }).from(repos).where(eq(repos.id, row.repoId)).limit(1),
  ]);
  const snapshot = toSnapshot(row, hbRows[0] ?? null, insightsMap.get(args.sessionId) ?? null);
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
  ctx?: ChatToolContext,
): ChatToolDefinition[] {
  return [
    {
      name: "get_team_activity",
      description:
        "Per-teammate roll-up of recent Claude Code / Codex sessions across repos the caller can see. Returns teammates (including the caller) with up to 3 recent sessions each. Each session carries title, description, state, repo, branch, lastTs, current tool, a truncated last user prompt, top edited files, tool-error count, and source (claude|codex). Filter by login or repoFullName to scope the answer; prefer those filters over fetching everyone and filtering locally. Pass `filePath` to find which other teammates are currently editing a specific file (the caller is excluded from this view).",
      input_schema: {
        type: "object",
        properties: {
          sinceHours: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LOOKBACK_HOURS,
            description:
              "Lookback window in hours; default 48. Use a smaller value for 'right now' questions; larger (up to 168) for 'catch me up' over days.",
          },
          since: {
            type: "string",
            description:
              "ISO8601 timestamp for the inclusive start of the activity window. Prefer this for calendar-relative questions like 'today'. If provided, it wins over sinceHours.",
          },
          state: {
            type: "string",
            enum: ["busy", "active", "idle", "recent"],
            description: "Filter to a single session state",
          },
          login: {
            type: "string",
            description:
              "GitHub login to scope the answer to a single teammate. Pass the bare login, not `@login`.",
          },
          repoFullName: {
            type: "string",
            description:
              "owner/name to scope the answer to a single repo. Must be a repo the caller can see.",
          },
          filePath: {
            type: "string",
            description:
              "Conflict-detection filter. When set, returns only teammates with a recent session whose top edited files include this path; the caller is omitted. Absolute or repo-relative paths are accepted — matching is segment-aware suffix on both sides. Lockfiles and similar high-traffic paths (package.json, bun.lock, yarn.lock, …) always return no overlap; they are noise, not collaboration. Pair with `repoFullName` to keep the answer tight.",
          },
        },
      },
      handler: async (input) => {
        const result = await getTeamActivityImpl(db, userId, input as GetTeamActivityArgs, ctx);
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
        const result = await getSessionImpl(db, userId, input as unknown as GetSessionArgs);
        if (result.kind === "error") {
          return { content: result.message, isError: true };
        }
        return { content: JSON.stringify(result.session) };
      },
    },
  ];
}

function resolveSince(args: GetTeamActivityArgs): Date {
  if (args.since) {
    const parsed = new Date(args.since);
    if (!Number.isNaN(parsed.getTime())) return clampSince(parsed);
  }

  const rawHours = args.sinceHours ?? DEFAULT_LOOKBACK_HOURS;
  const sinceHours = Math.min(Math.max(rawHours, 1), MAX_LOOKBACK_HOURS);
  return new Date(Date.now() - sinceHours * 60 * 60 * 1000);
}

function clampSince(since: Date): Date {
  const oldest = Date.now() - MAX_LOOKBACK_HOURS * 60 * 60 * 1000;
  if (since.getTime() < oldest) return new Date(oldest);
  return since;
}
