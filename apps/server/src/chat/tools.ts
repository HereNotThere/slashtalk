import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, users, repos } from "../db/schema";
import type { toSnapshot } from "../sessions/snapshot";
import { hydrateSession, hydrateSessions } from "../sessions/read-model";
import { canReadRepo, visibleRepoIdsForUser, visibleUserIdsForRepoIds } from "../repo/visibility";
import type { EventSource, SessionPr, SessionState } from "@slashtalk/shared";
import { normalizeFullName } from "../social/github-sync";
import { isCollisionIgnoredPath } from "../correlate/file-index";
import { truncateWithEllipsis } from "../util/text";

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
  pr: SessionPr | null;
}

export interface TeamActivityTeammate {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isSelf: boolean;
  sessions: TeamActivitySessionSummary[];
}

/** Open PR overlap surfaced when a `filePath` query matches a teammate session
 *  whose branch has an open PR. Returned even when the matching session is
 *  `ended` — the PR itself is the conflict signal, not whether the author is
 *  currently typing. Deduped by (repo, prNumber). */
export interface OpenPrOverlap {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  repo: string;
  branch: string;
  authorLogin: string;
  /** Most recent matching session ID (for follow-up `get_session`). */
  sessionId: string;
}

export interface TeamActivityResult {
  teammates: TeamActivityTeammate[];
  /** Inclusive window start, ISO8601 */
  since: string;
  /** Open PRs touching the queried `filePath`. Omitted when `filePath` is unset. */
  openPrs?: OpenPrOverlap[];
  /** When `login` was supplied, the github_logins it resolved to (could be
   *  empty if no peer matched). Lets the model distinguish "name didn't
   *  resolve" from "name resolved but no recent sessions in scope" — without
   *  this, both surface as `teammates: []` and the model defaults to the
   *  misleading "no teammate named X" answer. */
  resolvedLogins?: string[];
}

export interface GetTeamActivityArgs {
  sinceHours?: number;
  since?: string;
  state?: SessionState;
  login?: string;
  repoFullName?: string;
  filePath?: string;
  /** Opt back in to ended sessions in the teammates roll-up. Default omits
   *  them so "what's the team doing" doesn't drown in merge cleanup. */
  includeEnded?: boolean;
}

const SESSIONS_PER_USER_CAP = 3;
const LAST_PROMPT_MAX_CHARS = 240;
const TOP_FILES_IN_ROLLUP = 3;
const DEFAULT_LOOKBACK_HOURS = 48;
const MAX_LOOKBACK_HOURS = 168;
// Cap fuzzy login matches so a 1-letter query can't fan out to the whole org.
// Real first-name queries collide with at most a handful of teammates.
const FUZZY_LOGIN_MATCH_CAP = 5;

export interface ChatToolContext {
  /** Caller's visible repo IDs, if the runner already fetched them. Skips
   *  a per-request DB round-trip when provided. */
  visibleRepoIds?: number[];
  /** Caller's visible repo full names (`owner/name`). Used to bind the
   *  `delegate_to_local_agent` tool's `repoFullName` parameter to the exact
   *  set the desktop has tracked, so the model can't ask for one we don't
   *  have. Order matches `visibleRepoIds`; sorting/truncation is the
   *  caller's responsibility. */
  visibleRepoFullNames?: string[];
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
    repoIdScope = await visibleRepoIdsForUser(db, userId);
  }
  if (repoIdScope.length === 0) {
    return { teammates: [], since: since.toISOString() };
  }

  // Snapshot the full visible-repo set BEFORE applying args.repoFullName.
  // Login resolution runs against every peer the caller can see across all
  // shared repos — narrowing it to a single repo would silently miss e.g.
  // ryancooley when args.repoFullName="slashtalk" but ryancooley happens to
  // be linked via a different shared repo.
  const fullVisibleRepoIds = repoIdScope;

  const fullVisiblePeerIds = await visibleUserIdsForRepoIds(db, fullVisibleRepoIds);

  // `resolvedLogins` lets the model distinguish "name didn't match any peer"
  // (empty) from "matched but no sessions in scope" (non-empty + empty
  // teammates) — the latter wants `sinceHours` widened, not "no such teammate."
  const resolvedPeers = args.login
    ? await resolveLoginToPeers(db, args.login, fullVisiblePeerIds)
    : null;
  const userIdScope = resolvedPeers ? resolvedPeers.map((p) => p.id) : fullVisiblePeerIds;
  const resolvedLoginsField = resolvedPeers
    ? { resolvedLogins: resolvedPeers.map((p) => p.login) }
    : {};

  if (userIdScope.length === 0) {
    return { teammates: [], since: since.toISOString(), ...resolvedLoginsField };
  }

  if (args.repoFullName) {
    const [repoRow] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.fullName, normalizeFullName(args.repoFullName)))
      .limit(1);
    if (!repoRow || !repoIdScope.includes(repoRow.id)) {
      return { teammates: [], since: since.toISOString(), ...resolvedLoginsField };
    }
    repoIdScope = [repoRow.id];
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
  const hydratedRows = await hydrateSessions(db, sessionRows, {
    includeUsers: true,
    includeRepos: true,
  });

  // Default behavior: hide `ended` sessions from the rollup so "what's the
  // team doing" doesn't drown in merge cleanup from earlier in the window.
  // Caller can opt back in with `state: "ended"` or `includeEnded: true`.
  const omitEnded = !args.includeEnded && args.state !== "ended";

  // Track filePath-matched sessions before the ended filter so openPrs[]
  // can surface PRs from sessions whose author has already moved on.
  const filePathMatchedSessions: typeof hydratedRows = [];

  // sessionRows is already ordered `lastTs desc nulls last`, so the first
  // time a user's id appears is their most recent session — we rely on that
  // to sort teammates without a second sort pass.
  const byUser = new Map<number, TeamActivitySessionSummary[]>();
  for (const hydrated of hydratedRows) {
    const { row: s, snapshot, repo } = hydrated;
    if (args.filePath) {
      const editedPaths = snapshot.topFilesEdited.map(([p]) => p);
      if (!editedPaths.some((p) => pathMatches(p, args.filePath!))) continue;
      if (!args.state || snapshot.state === args.state) {
        filePathMatchedSessions.push(hydrated);
      }
    }
    if (args.state && snapshot.state !== args.state) continue;
    if (omitEnded && snapshot.state === "ended") continue;
    const arr = byUser.get(s.userId) ?? [];
    if (arr.length >= SESSIONS_PER_USER_CAP) continue;
    arr.push({
      id: snapshot.id,
      title: snapshot.title,
      description: snapshot.description,
      state: snapshot.state,
      source: s.source,
      repo: repo?.fullName ?? null,
      branch: snapshot.branch,
      lastTs: snapshot.lastTs,
      currentTool: snapshot.currentTool?.name ?? null,
      lastUserPrompt: truncateWithEllipsis(snapshot.lastUserPrompt, LAST_PROMPT_MAX_CHARS),
      topFilesEdited: snapshot.topFilesEdited.slice(0, TOP_FILES_IN_ROLLUP).map(([path]) => path),
      toolErrors: snapshot.toolErrors,
      pr: snapshot.pr ?? null,
    });
    byUser.set(s.userId, arr);
  }

  const teammates: TeamActivityTeammate[] = [...byUser.entries()].map(([uid, sess]) => {
    const u = hydratedRows.find((hydrated) => hydrated.row.userId === uid)?.user;
    return {
      login: u?.githubLogin ?? "unknown",
      name: u?.displayName ?? null,
      avatarUrl: u?.avatarUrl ?? null,
      isSelf: uid === userId,
      sessions: sess,
    };
  });

  // For conflict-detection lookups, the caller is the one editing the file —
  // surfacing themselves as overlap is noise.
  const finalTeammates = args.filePath ? teammates.filter((t) => !t.isSelf) : teammates;

  const result: TeamActivityResult = {
    teammates: finalTeammates,
    since: since.toISOString(),
    ...resolvedLoginsField,
  };

  if (args.filePath) {
    // Open PRs are stronger conflict signal than "is anyone typing right now".
    // Walk filePath-matched sessions newest-first and dedupe by (repo, PR#).
    const seen = new Set<string>();
    const openPrs: OpenPrOverlap[] = [];
    for (const { row: s, snapshot, repo } of filePathMatchedSessions) {
      if (s.userId === userId) continue;
      const pr = snapshot.pr;
      if (!pr || pr.state !== "open") continue;
      const key = `${s.repoId}:${pr.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      openPrs.push({
        prNumber: pr.number,
        prUrl: pr.url,
        prTitle: pr.title,
        repo: repo?.fullName ?? "",
        branch: s.branch ?? "",
        authorLogin: pr.authorLogin,
        sessionId: s.sessionId,
      });
    }
    result.openPrs = openPrs;
  }

  return result;
}

/** Resolve the model-supplied `login` (e.g. "ryan", "Ryan", "@ryancooley") to
 *  one or more peer user IDs. Order: exact case-insensitive `github_login`
 *  match → prefix match on `github_login` → substring match on `display_name`.
 *  All lookups are restricted to the caller's peer set so the result is always
 *  scoped to people whose sessions the caller can already see. */
async function resolveLoginToPeers(
  db: Database,
  rawLogin: string,
  peerIds: number[],
): Promise<Array<{ id: number; login: string }>> {
  const q = rawLogin.trim().replace(/^@+/, "").toLowerCase();
  if (!q || peerIds.length === 0) return [];

  const exact = await db
    .select({ id: users.id, login: users.githubLogin })
    .from(users)
    .where(and(inArray(users.id, peerIds), sql`lower(${users.githubLogin}) = ${q}`))
    .limit(1);
  if (exact.length > 0) return [exact[0]];

  const pat = escapeIlikeLiteral(q);
  return db
    .select({ id: users.id, login: users.githubLogin })
    .from(users)
    .where(
      and(
        inArray(users.id, peerIds),
        or(
          sql`${users.githubLogin} ilike ${pat + "%"}`,
          sql`coalesce(${users.displayName}, '') ilike ${"%" + pat + "%"}`,
        ),
      ),
    )
    .limit(FUZZY_LOGIN_MATCH_CAP);
}

/** Escape `%` and `_` so they're treated as literals inside an ILIKE pattern.
 *  Without this, `a_b` matches any single character between a and b. */
function escapeIlikeLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/[%_]/g, (c) => `\\${c}`);
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
  if (!(await canReadRepo(db, userId, row.repoId))) {
    return { kind: "error", message: "session not visible to caller" };
  }

  const {
    snapshot,
    user: u,
    repo: r,
  } = await hydrateSession(db, row, {
    includeUsers: true,
    includeRepos: true,
  });

  return {
    kind: "ok",
    session: {
      ...snapshot,
      user: u ? { login: u.githubLogin, name: u.displayName ?? null } : null,
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

/** Sentinel emitted by the `delegate_to_local_agent` tool's handler and
 *  detected by `runChatAgent`'s loop to short-circuit out of the
 *  Anthropic-side iteration. The tool itself is a signal channel, not an
 *  executor — the actual run happens on the desktop. */
export const DELEGATE_SENTINEL = "__delegate__";

export interface DelegatePayload {
  task: string;
  repoFullName?: string;
}

export function tryParseDelegatePayload(content: string): DelegatePayload | null {
  if (!content.includes(DELEGATE_SENTINEL)) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed[DELEGATE_SENTINEL] !== true) return null;
    const task = typeof parsed.task === "string" ? parsed.task.trim() : "";
    if (!task) return null;
    const repoFullName =
      typeof parsed.repoFullName === "string" && parsed.repoFullName.trim()
        ? parsed.repoFullName.trim()
        : undefined;
    return { task, repoFullName };
  } catch {
    return null;
  }
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
        'Per-teammate roll-up of recent Claude Code / Codex sessions across repos the caller can see. Returns teammates (including the caller) with up to 3 recent sessions each. Each session carries title, description, state, repo, branch, lastTs, current tool, a truncated last user prompt, top edited files, tool-error count, source (claude|codex), and `pr` (open/closed/merged PR matched by branch, when known). State thresholds: `busy` = heartbeat fresh (<30s) and in a turn; `active` = heartbeat fresh and last event <30s; `idle` = heartbeat fresh, last event >30s; `recent` = no fresh heartbeat but last event <1h; `ended` = no fresh heartbeat and last event >1h. By default `ended` sessions are omitted from the teammates roll-up (set `includeEnded: true` or `state: "ended"` to include them). Filter by login or repoFullName to scope the answer; prefer those filters over fetching everyone and filtering locally. When `login` is set the response also carries `resolvedLogins`: the actual github_logins the fuzzy match resolved to. An empty `resolvedLogins` means no peer matched the name; a non-empty `resolvedLogins` with `teammates: []` means the peer was found but had no sessions in the time/repo window — widen `sinceHours` or drop `repoFullName` instead of telling the user the teammate doesn\'t exist. Pass `filePath` to find which other teammates are currently editing a specific file (the caller is excluded from this view); the response also includes a top-level `openPrs` array of any open PRs whose branch had a teammate session touching that file — even when that session is `ended`, since the PR is the conflict signal.',
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
            enum: ["busy", "active", "idle", "recent", "ended"],
            description:
              "Filter to a single session state. Pass `ended` to opt into ended sessions (otherwise omitted by default).",
          },
          includeEnded: {
            type: "boolean",
            description:
              "Include `ended` sessions in the teammates roll-up without filtering to only ended. Default false.",
          },
          login: {
            type: "string",
            description:
              "Scope to one teammate. Accepts a GitHub login (`ryancooley`), a first name or fragment that prefix-matches a login (`ryan` → ryancooley), or a fragment of a display name. Match is case-insensitive and scoped to the caller's visible peers, so an unknown name returns empty rather than guessing.",
          },
          repoFullName: {
            type: "string",
            description:
              "owner/name to scope the answer to a single repo. Must be a repo the caller can see.",
          },
          filePath: {
            type: "string",
            description:
              "Conflict-detection filter. When set, returns only teammates with a recent session whose top edited files include this path; the caller is omitted. Response also includes a top-level `openPrs` array of any open PRs whose branch had a teammate session touching that file. Absolute or repo-relative paths are accepted — matching is segment-aware suffix on both sides. Lockfiles and similar high-traffic paths (package.json, bun.lock, yarn.lock, …) always return no overlap; they are noise, not collaboration. Pair with `repoFullName` to keep the answer tight.",
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
    {
      name: "delegate_to_local_agent",
      description:
        "Hand off the question to a read-only Claude Code agent running on the user's desktop, scoped to one of their tracked repos. Use this when the question requires reading repo source files, inspecting git history (commits, blame, diffs), running build/test commands, or querying authoritative GitHub state via `gh` (PRs, CI runs, issues). Examples: 'where is X defined', 'what changed in Y last week', 'why does typecheck fail in Z', 'how does the auth flow work in this repo', 'is PR 123 merged', 'what's the CI status on branch foo'. The local agent has gh CLI auth, so PR/CI questions go through the GitHub remote and are fresher than the `pr` field from get_team_activity (which is best-effort and can lag). Pass a `task` (one paragraph instructing the local agent what to investigate and answer; rephrase the user's question if it helps) and `repoFullName` if you can identify the target repo from context. Do NOT use this for questions about teammates' presence/activity — those are answered by get_team_activity / get_session.",
      input_schema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "One-paragraph task description for the local agent. State the question and any context the user gave; the local agent will read the repo, run git or test commands as needed, and return a single concise answer.",
          },
          repoFullName: {
            type: "string",
            ...(ctx?.visibleRepoFullNames && ctx.visibleRepoFullNames.length > 0
              ? { enum: ctx.visibleRepoFullNames }
              : {}),
            description: buildRepoFullNameDescription(ctx?.visibleRepoFullNames),
          },
        },
        required: ["task"],
      },
      handler: async (input) => {
        const task = typeof input.task === "string" ? input.task : "";
        const repoFullName =
          typeof input.repoFullName === "string" && input.repoFullName
            ? input.repoFullName
            : undefined;
        const payload: Record<string, unknown> = {
          [DELEGATE_SENTINEL]: true,
          task,
          ...(repoFullName ? { repoFullName } : {}),
        };
        return { content: JSON.stringify(payload) };
      },
    },
  ];
}

// Cap the inline list to keep the tool description (which goes through the
// prompt cache) from ballooning when the caller has hundreds of tracked
// repos. The `enum` constraint above is the authoritative gate; this string
// is just a hint so the model picks the right one.
const MAX_REPOS_IN_DELEGATE_HINT = 50;

function buildRepoFullNameDescription(visibleRepoFullNames: string[] | undefined): string {
  const base =
    "owner/name of the repo to scope the agent to. Omit if the user's question doesn't clearly map to a specific repo — the desktop will then prompt the user to pick from their tracked set.";
  if (!visibleRepoFullNames || visibleRepoFullNames.length === 0) {
    return `${base} The caller has not tracked any repos yet, so delegation will fail until they add one — prefer answering from team-presence tools or telling the user to add a repo from the desktop tray.`;
  }
  const sorted = [...visibleRepoFullNames].sort();
  const shown = sorted.slice(0, MAX_REPOS_IN_DELEGATE_HINT).join(", ");
  const overflow =
    sorted.length > MAX_REPOS_IN_DELEGATE_HINT
      ? `, …and ${sorted.length - MAX_REPOS_IN_DELEGATE_HINT} more`
      : "";
  return `${base} MUST be exactly one of the caller's tracked repos: ${shown}${overflow}. Never invent a repo or use one not on this list — the desktop has no access to anything else and will refuse the task.`;
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
