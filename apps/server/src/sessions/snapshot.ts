/**
 * Transform a DB session row + heartbeat into the snapshot JSON shape
 * that matches upload.spec.md exactly.
 */

import { inArray } from "drizzle-orm";
import { classifySessionState } from "./state";
import type { SessionState, EventSource } from "@slashtalk/shared";
import type { Database } from "../db";
import { sessionInsights } from "../db/schema";
import {
  SUMMARY_ANALYZER,
  ROLLING_SUMMARY_ANALYZER,
} from "../analyzers/names";

interface SessionRow {
  sessionId: string;
  project: string;
  source: EventSource;
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
  now?: Date
) {
  const currentTime = now ?? new Date();
  const state = classifySessionState({
    heartbeatUpdatedAt: heartbeat?.updatedAt ?? null,
    inTurn: session.inTurn ?? false,
    lastTs: session.lastTs,
    now: currentTime,
  });

  return buildSnapshot(session, heartbeat, state, insights, currentTime);
}

export function buildSnapshot(
  session: SessionRow,
  heartbeat: HeartbeatRow | null,
  state: SessionState,
  insights?: SessionInsightsForSnapshot | null,
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
    source: session.source,
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
