// Local persistence for user-created managed agents. Backs the renderer's
// agent list; the Anthropic API is the source of truth but we cache metadata
// locally so agent bubbles render instantly on app launch.

import * as store from "./store";
import { createEmitter } from "./emitter";
import type { AgentMode, AgentVisibility } from "../shared/types";

export interface SessionTokens {
  input: number;
  output: number;
}

export interface LocalSession {
  id: string; // Anthropic session_id
  createdAt: number;
  /** Derived from the first user message in the session. Populated lazily. */
  title?: string;
  /** Sum of model-request usage across this session. Populated either by
   *  streaming (span.model_request_end events) or a one-time backfill scan. */
  tokens?: SessionTokens;
}

export interface LocalAgent {
  id: string; // Anthropic agent_id (cloud) or local:<uuid> (local)
  name: string;
  description?: string;
  systemPrompt: string;
  model: string;
  createdAt: number;
  /** Conversations with this agent. Newest is typically at the end; UI sorts
   *  as it sees fit. */
  sessions: LocalSession[];
  /** Currently-selected session — new messages go here, history loads from
   *  here. null before the first send. */
  activeSessionId?: string;
  /** Runtime: 'cloud' = Anthropic Managed Agents, 'local' = Claude Agent SDK
   *  in this process. Undefined = 'cloud' (back-compat with older records). */
  mode?: AgentMode;
  /** Absolute working directory for local agents. Unused for cloud. */
  cwd?: string;
  /** Whether this agent's sessions flow to the chatheads backend as pointers
   *  + client-generated summaries. Undefined treated as 'private'. */
  visibility?: AgentVisibility;
}

const AGENTS_KEY = "anthropic.agents";
const changes = createEmitter<LocalAgent[]>();

export const onChange = changes.on;

function load(): LocalAgent[] {
  const raw = store.get<LocalAgent[]>(AGENTS_KEY) ?? [];
  // Migrate pre-multi-session records: if `sessions` is missing and an
  // `activeSessionId` exists, seed the list with that one session.
  let changed = false;
  const migrated = raw.map((a) => {
    if (Array.isArray(a.sessions)) return a;
    changed = true;
    const seed: LocalSession[] = a.activeSessionId
      ? [{ id: a.activeSessionId, createdAt: a.createdAt }]
      : [];
    return { ...a, sessions: seed };
  });
  if (changed) store.set(AGENTS_KEY, migrated);
  return migrated;
}

function save(next: LocalAgent[]): void {
  store.set(AGENTS_KEY, next);
  changes.emit(next);
}

export function list(): LocalAgent[] {
  return load();
}

export function add(a: Omit<LocalAgent, "sessions"> & { sessions?: LocalSession[] }): void {
  save([...load(), { ...a, sessions: a.sessions ?? [] }]);
}

export function remove(id: string): void {
  save(load().filter((a) => a.id !== id));
}

export function setActiveSession(agentId: string, sessionId: string | null): void {
  const next = load().map((a) =>
    a.id === agentId
      ? { ...a, activeSessionId: sessionId ?? undefined }
      : a,
  );
  save(next);
}

/** Appends a session and makes it active. No-op if the id already exists. */
export function addSession(agentId: string, session: LocalSession): void {
  const next = load().map((a) => {
    if (a.id !== agentId) return a;
    if (a.sessions.some((s) => s.id === session.id)) {
      return { ...a, activeSessionId: session.id };
    }
    return {
      ...a,
      sessions: [...a.sessions, session],
      activeSessionId: session.id,
    };
  });
  save(next);
}

export function setSessionTitle(
  agentId: string,
  sessionId: string,
  title: string,
): void {
  const next = load().map((a) => {
    if (a.id !== agentId) return a;
    const sessions = a.sessions.map((s) =>
      s.id === sessionId ? { ...s, title } : s,
    );
    return { ...a, sessions };
  });
  save(next);
}

/** Adds to the running token total for a live session (called on every
 *  span.model_request_end event). Initializes if not yet set. */
export function addSessionUsage(
  agentId: string,
  sessionId: string,
  delta: SessionTokens,
): void {
  const next = load().map((a) => {
    if (a.id !== agentId) return a;
    const sessions = a.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            tokens: {
              input: (s.tokens?.input ?? 0) + delta.input,
              output: (s.tokens?.output ?? 0) + delta.output,
            },
          }
        : s,
    );
    return { ...a, sessions };
  });
  save(next);
}

/** Replaces the session's token total (used by backfill, which computes the
 *  full sum in one pass). */
export function setSessionUsage(
  agentId: string,
  sessionId: string,
  total: SessionTokens,
): void {
  const next = load().map((a) => {
    if (a.id !== agentId) return a;
    const sessions = a.sessions.map((s) =>
      s.id === sessionId ? { ...s, tokens: total } : s,
    );
    return { ...a, sessions };
  });
  save(next);
}

export function get(id: string): LocalAgent | undefined {
  return load().find((a) => a.id === id);
}

/** Drops a session from the local cache. No server call — callers should do
 *  that separately (via archive or delete). */
export function removeSession(agentId: string, sessionId: string): void {
  const next = load().map((a) => {
    if (a.id !== agentId) return a;
    return {
      ...a,
      sessions: a.sessions.filter((s) => s.id !== sessionId),
      activeSessionId:
        a.activeSessionId === sessionId ? undefined : a.activeSessionId,
    };
  });
  save(next);
}

/** Reconcile local sessions with the server's list. Server wins on `title`
 *  unless it's null and local has one (preserves the cached title during the
 *  brief window between local set and the server PATCH). Preserves
 *  local-only fields (`tokens`) on known sessions. */
export function reconcileSessions(
  agentId: string,
  serverSessions: Array<{ id: string; createdAt: number; title?: string }>,
): void {
  const next = load().map((a) => {
    if (a.id !== agentId) return a;
    const localById = new Map(a.sessions.map((s) => [s.id, s]));
    const merged: LocalSession[] = serverSessions.map((srv) => {
      const local = localById.get(srv.id);
      return {
        ...local,
        id: srv.id,
        createdAt: srv.createdAt,
        title: srv.title ?? local?.title,
      };
    });
    // If the currently-active session got archived away, clear the pointer.
    const stillActive =
      a.activeSessionId && merged.some((s) => s.id === a.activeSessionId);
    return {
      ...a,
      sessions: merged,
      activeSessionId: stillActive ? a.activeSessionId : undefined,
    };
  });
  save(next);
}
