/** Session state — computed at read time, never stored */
export const SessionState = {
  BUSY: "busy",
  ACTIVE: "active",
  IDLE: "idle",
  RECENT: "recent",
  ENDED: "ended",
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** Token usage bucket */
export interface TokenUsage {
  in: number;
  cw5: number;
  cw1: number;
  cr: number;
  out: number;
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
  title: string | null;
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
  cost: number;
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

/** Ingest response */
export interface IngestResponse {
  acceptedBytes: number;
  acceptedEvents: number;
  duplicateEvents: number;
  serverOffset: number;
}

/** Sync state entry */
export interface SyncStateEntry {
  serverOffset: number;
  prefixHash: string | null;
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
