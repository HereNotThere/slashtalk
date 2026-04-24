/** Session state — computed at read time, never stored */
export const SessionState = {
  BUSY: "busy",
  ACTIVE: "active",
  IDLE: "idle",
  RECENT: "recent",
  ENDED: "ended",
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** Source of a session's JSONL events */
export const SOURCES = ["claude", "codex"] as const;
export type EventSource = (typeof SOURCES)[number];

/** LLM provider a session's model belongs to */
export const PROVIDERS = ["anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Normalized event kind — source-agnostic vocabulary for queries */
export const EVENT_KINDS = [
  "user_msg",
  "assistant_msg",
  "reasoning",
  "tool_call",
  "tool_result",
  "turn_start",
  "turn_end",
  "token_usage",
  "system",
  "meta",
  "unknown",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Token usage bucket — provider-agnostic */
export interface TokenUsage {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** Queued command entry */
export interface QueuedCommand {
  prompt: string;
  ts: string;
  mode: string | null;
}

/** Current tool hint */
export interface CurrentTool {
  name: string;
  desc: string | null;
  started: number;
}

/** Recent event summary */
export interface RecentEvent {
  ts: string;
  type: string;
  summary: string;
}

/** Full session snapshot — shared between server API and desktop client */
export interface SessionSnapshot {
  id: string;
  project: string;
  source: EventSource;
  title: string | null;
  description: string | null;
  rollingSummary: string | null;
  highlights: string[] | null;
  queued: QueuedCommand[];
  state: SessionState;
  pid: number | null;
  kind: string | null;
  model: string | null;
  version: string | null;
  branch: string | null;
  cwd: string | null;
  firstTs: string | null;
  lastTs: string | null;
  idleS: number | null;
  durationS: number | null;
  userMsgs: number;
  assistantMsgs: number;
  toolCalls: number;
  toolErrors: number;
  events: number;
  tokens: TokenUsage;
  cacheHitRate: number | null;
  burnPerMin: number | null;
  lastUserPrompt: string | null;
  currentTool: CurrentTool | null;
  topFilesRead: [string, number][];
  topFilesEdited: [string, number][];
  topFilesWritten: [string, number][];
  toolUseNames: [string, number][];
  recent: RecentEvent[];
}

/** Feed-augmented session snapshot (includes social graph fields) */
export interface FeedSessionSnapshot extends SessionSnapshot {
  github_login: string;
  avatar_url: string | null;
  repo_full_name: string | null;
}

/** Feed user summary */
export interface FeedUser {
  github_login: string;
  avatar_url: string | null;
  total_sessions: number;
  active_sessions: number;
  repos: string[];
}

/** GitHub org the user is a member of. */
export interface OrgSummary {
  login: string;
  name: string | null;
  avatarUrl: string;
}

/** Repo within an org as returned by GitHub's /orgs/:org/repos endpoint,
 *  scoped to those readable by the authenticated user. */
export interface OrgRepo {
  repoId: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  permission: "pull" | "triage" | "push" | "maintain" | "admin";
}

/** One managed-agent session stored in the MCP backend's agent_sessions table.
 *  Private agent sessions never reach the backend, so every row returned here
 *  is visibility='team'. Both server and desktop speak this shape so there is
 *  no skew between the PUT payload and GET response. */
export interface AgentSessionRow {
  user_login: string;
  agent_id: string;
  session_id: string;
  mode: "cloud" | "local";
  visibility: "private" | "team";
  name: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity: string;
  summary: string | null;
  summary_model: string | null;
  summary_ts: string | null;
}

/** Ingest response */
export interface IngestResponse {
  acceptedEvents: number;
  duplicateEvents: number;
  serverLineSeq: number;
}

/** Sync state entry */
export interface SyncStateEntry {
  serverLineSeq: number;
  prefixHash: string | null;
}

/** WS push: a teammate just opened or merged a PR on a shared repo. */
export interface PrActivityMessage {
  type: "pr_activity";
  /** opened | merged */
  action: "opened" | "merged";
  /** GitHub login of the actor */
  login: string;
  /** owner/name */
  repoFullName: string;
  /** PR number */
  number: number;
  title: string;
  url: string;
  /** ISO8601 */
  ts: string;
}

/**
 * WS push: a session's aggregates or live-state changed.
 *
 * Fires on ingest (new events) and on heartbeat (state transition). Only
 * published once the session has been matched to a repo — fans out exclusively
 * on `repo:<id>`, so each subscribed client receives it exactly once. Session
 * owners invalidate their own cache locally via `uploader.onIngested`.
 *
 * Clients should treat it as "invalidate your cached snapshot for this
 * session" and re-fetch via `/api/sessions` or `/api/feed` — the message
 * carries enough to locate the head but not a full snapshot.
 */
export interface SessionUpdatedMessage {
  type: "session_updated";
  session_id: string;
  user_id: number;
  github_login: string;
  repo_id: number;
  /** Present when fired from ingest; ISO8601 */
  last_ts?: string;
  /** Present when fired from heartbeat state-change */
  state?: SessionState;
}

/**
 * Chat (team-presence Q&A). The server is stateless: the client owns the
 * thread and re-sends the full `messages` array on every turn. Tool turns
 * are hidden from the client — only user-visible text + citations come back.
 */
export interface ChatCitation {
  sessionId: string;
  reason: string;
}

export interface ChatUserMessage {
  role: "user";
  content: string;
}

/**
 * Compact session card rendered underneath an assistant message. Server
 * hydrates these from sessions the model cited in the answer; visibility
 * is scoped to the caller's user_repos like everywhere else.
 */
export interface SessionCard {
  id: string;
  user: {
    login: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  title: string | null;
  state: SessionState;
  repo: string | null;
  branch: string | null;
  lastTs: string | null;
  currentTool: string | null;
  lastUserPrompt: string | null;
  source: EventSource;
}

export interface ChatAssistantMessage {
  role: "assistant";
  content: string;
  citations?: ChatCitation[];
  cards?: SessionCard[];
}

export type ChatMessage = ChatUserMessage | ChatAssistantMessage;

export interface ChatAskRequest {
  messages: ChatMessage[];
}

export interface ChatAskResponse {
  message: ChatAssistantMessage;
}

/** Standard API response wrapper */
export interface ApiResponse<T> {
  data: T;
}

/** Error response */
export interface ApiError {
  error: string;
  message: string;
}
