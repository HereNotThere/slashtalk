/**
 * Transform a DB session row + heartbeat into the snapshot JSON shape
 * that matches upload.spec.md exactly.
 */

import { inArray, or, and, eq, sql } from "drizzle-orm";
import { classifySessionState } from "./state";
import type { SessionPr, SessionState } from "@slashtalk/shared";
import type { Database } from "../db";
import { pullRequests, sessionInsights } from "../db/schema";
import {
  SUMMARY_ANALYZER,
  ROLLING_SUMMARY_ANALYZER,
} from "../analyzers/names";

interface SessionRow {
  sessionId: string;
  project: string;
  title: string | null;
  model: string | null;
  version: string | null;
  branch: string | null;
  cwd: string | null;
  firstTs: Date | null;
  lastTs: Date | null;
  userMsgs: number | null;
  assistantMsgs: number | null;
  toolCalls: number | null;
  toolErrors: number | null;
  events: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  tokensReasoning: number | null;
  inTurn: boolean | null;
  lastBoundaryTs: Date | null;
  outstandingTools: unknown;
  lastUserPrompt: string | null;
  topFilesRead: unknown;
  topFilesEdited: unknown;
  topFilesWritten: unknown;
  toolUseNames: unknown;
  queued: unknown;
  recentEvents: unknown;
}

interface HeartbeatRow {
  pid: number | null;
  kind: string | null;
  updatedAt: Date | null;
}

/**
 * LLM-derived insights loaded from session_insights, keyed by analyzer name.
 * Callers pass whatever they have; missing analyzers → snapshot fields stay null.
 */
export interface SessionInsightsForSnapshot {
  summary?: { title?: string; description?: string } | null;
  rollingSummary?: { summary?: string; highlights?: string[] } | null;
}

function mapToSortedPairs(obj: unknown, limit: number): [string, number][] {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, number>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export function toSnapshot(
  session: SessionRow,
  heartbeat: HeartbeatRow | null,
  insights?: SessionInsightsForSnapshot | null,
  pr?: SessionPr | null,
  now?: Date
) {
  const currentTime = now ?? new Date();
  const state = classifySessionState({
    heartbeatUpdatedAt: heartbeat?.updatedAt ?? null,
    inTurn: session.inTurn ?? false,
    lastTs: session.lastTs,
    now: currentTime,
  });

  return buildSnapshot(session, heartbeat, state, insights, pr, currentTime);
}

export function buildSnapshot(
  session: SessionRow,
  heartbeat: HeartbeatRow | null,
  state: SessionState,
  insights?: SessionInsightsForSnapshot | null,
  pr?: SessionPr | null,
  now?: Date
) {
  const currentTime = now ?? new Date();
  const lastTs = session.lastTs;
  const firstTs = session.firstTs;

  const idleS = lastTs
    ? Math.floor((currentTime.getTime() - lastTs.getTime()) / 1000)
    : null;
  const durationS =
    firstTs && lastTs
      ? Math.floor((lastTs.getTime() - firstTs.getTime()) / 1000)
      : null;

  const tokens = {
    in: session.tokensIn ?? 0,
    out: session.tokensOut ?? 0,
    cacheRead: session.tokensCacheRead ?? 0,
    cacheWrite: session.tokensCacheWrite ?? 0,
    reasoning: session.tokensReasoning ?? 0,
  };

  const totalInput = tokens.in + tokens.cacheRead + tokens.cacheWrite;
  const cacheHitRate = totalInput > 0 ? tokens.cacheRead / totalInput : null;

  const durationMin = durationS ? durationS / 60 : null;
  const burnPerMin =
    durationMin && durationMin > 0
      ? Math.round(tokens.out / durationMin)
      : null;

  // Outstanding tools → currentTool
  const outstanding = (session.outstandingTools ?? {}) as Record<
    string,
    { name: string; desc: string | null; started: number }
  >;
  const toolEntries = Object.values(outstanding);
  const currentTool =
    toolEntries.length > 0 ? toolEntries[toolEntries.length - 1] : null;

  // Filter queued by last_boundary_ts
  const allQueued = (session.queued ?? []) as Array<{
    prompt: string;
    ts: string;
    mode: string | null;
  }>;
  const boundaryTs = session.lastBoundaryTs;
  const queued = boundaryTs
    ? allQueued.filter((q) => new Date(q.ts) > boundaryTs)
    : allQueued;

  // LLM-derived overrides — prefer summary.title when present so the UI
  // doesn't fall back to lastUserPrompt. Leave heuristic title in place as a
  // fallback if no insight exists yet.
  const summaryTitle = insights?.summary?.title ?? null;
  const summaryDescription = insights?.summary?.description ?? null;
  const rollingSummary = insights?.rollingSummary?.summary ?? null;
  // Stale rows (older analyzer shapes, schema-violating LLM output) can land
  // here as a string or object. Coerce to string[] so clients can .map safely.
  const rawHighlights = insights?.rollingSummary?.highlights;
  const highlights = Array.isArray(rawHighlights)
    ? rawHighlights.filter((h): h is string => typeof h === "string")
    : null;

  return {
    id: session.sessionId,
    project: session.project,
    title: summaryTitle ?? session.title,
    description: summaryDescription,
    rollingSummary,
    highlights,
    queued,
    state,
    pid: heartbeat?.pid ?? null,
    kind: heartbeat?.kind ?? null,
    model: session.model,
    version: session.version,
    branch: session.branch,
    cwd: session.cwd,
    firstTs: session.firstTs?.toISOString() ?? null,
    lastTs: session.lastTs?.toISOString() ?? null,
    idleS,
    durationS,
    userMsgs: session.userMsgs ?? 0,
    assistantMsgs: session.assistantMsgs ?? 0,
    toolCalls: session.toolCalls ?? 0,
    toolErrors: session.toolErrors ?? 0,
    events: session.events ?? 0,
    tokens,
    cacheHitRate,
    burnPerMin,
    lastUserPrompt: session.lastUserPrompt,
    currentTool,
    topFilesRead: mapToSortedPairs(session.topFilesRead, 5),
    topFilesEdited: mapToSortedPairs(session.topFilesEdited, 5),
    topFilesWritten: mapToSortedPairs(session.topFilesWritten, 5),
    toolUseNames: mapToSortedPairs(session.toolUseNames, 10),
    recent: (session.recentEvents ?? []) as Array<{
      ts: string;
      type: string;
      summary: string;
    }>,
    pr: pr ?? null,
  };
}

/**
 * Batch-load session_insights for a set of session IDs. Returns a map keyed
 * by session_id whose value holds the per-analyzer outputs the snapshot cares
 * about. Missing analyzers → undefined, callers treat as "no insight yet".
 */
export async function loadInsightsForSessions(
  db: Database,
  sessionIds: string[],
): Promise<Map<string, SessionInsightsForSnapshot>> {
  const result = new Map<string, SessionInsightsForSnapshot>();
  if (sessionIds.length === 0) return result;

  const rows = await db
    .select({
      sessionId: sessionInsights.sessionId,
      analyzerName: sessionInsights.analyzerName,
      output: sessionInsights.output,
      errorText: sessionInsights.errorText,
    })
    .from(sessionInsights)
    .where(inArray(sessionInsights.sessionId, sessionIds));

  for (const row of rows) {
    if (row.errorText) continue;
    const slot = result.get(row.sessionId) ?? {};
    if (row.analyzerName === SUMMARY_ANALYZER) {
      slot.summary = row.output as SessionInsightsForSnapshot["summary"];
    } else if (row.analyzerName === ROLLING_SUMMARY_ANALYZER) {
      slot.rollingSummary =
        row.output as SessionInsightsForSnapshot["rollingSummary"];
    }
    result.set(row.sessionId, slot);
  }
  return result;
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
  const pairs = [...uniquePairs.values()];

  const conditions = pairs.map((p) =>
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
    // First row wins (desc order → most recent).
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

/** State priority for feed ordering */
const STATE_ORDER: Record<string, number> = {
  busy: 0,
  active: 1,
  idle: 2,
  recent: 3,
  ended: 4,
};

export function sortByStateThenTime<T extends { state: string; lastTs: string | null }>(
  items: T[]
): T[] {
  return items.sort((a, b) => {
    const sa = STATE_ORDER[a.state] ?? 5;
    const sb = STATE_ORDER[b.state] ?? 5;
    if (sa !== sb) return sa - sb;
    const ta = a.lastTs ? new Date(a.lastTs).getTime() : 0;
    const tb = b.lastTs ? new Date(b.lastTs).getTime() : 0;
    return tb - ta;
  });
}
