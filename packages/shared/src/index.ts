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
export const SOURCES = ["claude", "codex", "cursor"] as const;
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

/** PR linked to a session via (repo_id, branch). Populated only when the
 *  pr-poller has seen a PR whose head ref matches the session's branch on the
 *  session's repo — absence means "not known", not "no PR". */
export interface SessionPr {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  authorLogin: string;
}

/** A PR authored by a specific user inside the dashboard window. Shape
 *  mirrors what the info-card "PRs pushed" section needs. The endpoint that
 *  returns these gates by `user_repos` overlap between caller and target so
 *  callers only see PRs on repos they share with the target. */
export interface UserPr {
  number: number;
  title: string;
  url: string;
  repoFullName: string;
  state: "open" | "closed" | "merged";
  updatedAt: string;
}

export interface UserPrsResponse {
  prs: UserPr[];
  /** True only on the self path when the caller has no claimed `user_repos`
   *  rows. Renderers should surface a "claim a repo" CTA rather than an empty
   *  list — without this signal, "0 PRs" is ambiguous (genuinely quiet day vs.
   *  no repos selected). Never set for peer queries. */
  noClaimedRepos?: boolean;
}

/** Desktop → server push of PRs the caller authored, sourced from the local
 *  `gh` CLI. Lets the server keep `pull_requests` fresh without waiting for
 *  the events-feed poller, so the standup composer can mention them. The
 *  server filters to entries where `pr.repoFullName` is a known repo and
 *  treats `caller.githubLogin` as the only valid `authorLogin` — desktops
 *  cannot ingest PRs on behalf of other users. */
export interface IngestSelfPrEntry {
  number: number;
  title: string;
  url: string;
  repoFullName: string;
  state: "open" | "closed" | "merged";
  updatedAt: string;
  headRef: string;
}

export interface IngestSelfPrsRequest {
  prs: IngestSelfPrEntry[];
}

export interface IngestSelfPrsResponse {
  /** PRs upserted into `pull_requests`. */
  upserted: number;
  /** PRs dropped because the repo isn't in `repos` (not claimed by anyone). */
  unknownRepos: number;
}

/** LLM-composed standup blurb for a specific user. `summary` is null when
 *  the window has nothing substantive to summarize (no shipped PRs, no
 *  rolling-summary insights). */
export interface StandupResponse {
  summary: string | null;
  /** See `UserPrsResponse.noClaimedRepos`. */
  noClaimedRepos?: boolean;
}

/** A PR shown in the project overview. Carries author info because the
 *  project view spans multiple authors (the user-card `UserPr` omits this
 *  since that view is already filtered to one author). */
export interface ProjectPr {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  authorLogin: string;
  authorAvatarUrl: string | null;
  updatedAt: string;
}

/** Category bucket emergent from the LLM's per-call analysis of the repo's
 *  active PRs. Names vary per call — a docs sprint repo may produce
 *  "docs / examples / typos", an infra repo "terraform / k8s / observability"
 *  — no fixed taxonomy. `prNumbers` indexes into `ProjectOverviewResponse.prs`. */
export interface ProjectBucket {
  name: string;
  prNumbers: number[];
}

/** Person contributing to the repo inside the window. Active = authored a
 *  PR updated in window, or had a session whose `lastTs` is in window. */
export interface ProjectActivePerson {
  login: string;
  avatarUrl: string | null;
  /** ISO8601 — most recent activity timestamp inside the window. */
  lastTs: string;
}

/** Response for `GET /api/repos/:owner/:name/overview`. The `pulse` is a
 *  directional one-liner ("half the team's adding payments while alice & bob
 *  polish auth"). `buckets` are emergent categories over the same PR set as
 *  `prs`. `active` is the people strip. The window is always `now - 24h`. */
export interface ProjectOverviewResponse {
  /** Null when nothing substantive happened in window (renderer hides the
   *  pulse line and shows the empty-state copy). */
  pulse: string | null;
  buckets: ProjectBucket[];
  prs: ProjectPr[];
  active: ProjectActivePerson[];
}

/** A user prompt captured at ingest — what the developer asked for. */
export interface RecentPrompt {
  ts: string;
  text: string;
}

/** Full session snapshot — shared between server API and desktop client */
export interface SessionSnapshot {
  id: string;
  source: EventSource;
  project: string;
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
  recentPrompts: RecentPrompt[];
  pr: SessionPr | null;
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

/** One managed-agent session stored in the server's agent_sessions table.
 *  Private agent sessions never reach the backend, so every row returned here
 *  is visibility='team'. Both server and desktop speak this shape so there is
 *  no skew between the PUT payload and GET response. */
export interface ManagedAgentSessionRow {
  userLogin: string;
  agentId: string;
  sessionId: string;
  mode: "cloud" | "local";
  visibility: "private" | "team";
  name: string | null;
  startedAt: string;
  endedAt: string | null;
  lastActivity: string;
  summary: string | null;
  summaryModel: string | null;
  summaryTs: string | null;
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

/** WS push: an analyzer cron published new output for a session.
 *
 *  Fired from `apps/server/src/analyzers/scheduler.ts` after each successful
 *  analyzer run. The desktop info popover treats this as "your cached
 *  insights for this session are stale — replace with `output`". */
export interface SessionInsightsUpdatedMessage {
  type: "session_insights_updated";
  session_id: string;
  repo_id: number;
  /** Analyzer name (e.g. "summary", "rolling-summary") — the output shape
   *  varies by analyzer, see apps/server/src/analyzers/registry.ts. */
  analyzer: string;
  output: unknown;
  /** ISO8601 */
  analyzed_at: string;
}

/**
 * WS push: two or more live sessions in the same repo are touching the same
 * file. Computed in-memory by `apps/server/src/correlate/file-index.ts` and
 * fired from the ingest path on the same `repo:<id>` channel as session
 * updates. Transient — not persisted. The desktop renders a yellow ring on
 * the trigger and each `others` head, and an "also editing" chip on the
 * affected session card.
 */
export interface CollisionDetectedMessage {
  type: "collision_detected";
  repo_id: number;
  file_path: string;
  /** ISO8601 — when the collision was detected, not when the file was first touched. */
  ts: string;
  /** The session whose ingest just newly added this file to its top-edited set. */
  trigger: { sessionId: string; userId: number; githubLogin: string };
  /** Other live sessions (different users) currently touching the same file. */
  others: Array<{ sessionId: string; userId: number; githubLogin: string }>;
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
  /** Set when the server chat planner judged the question needs repo access
   *  and needs a bounded local repo snapshot. The desktop receives this on
   *  the response, collects the fixed snapshot for a tracked repo (or asks
   *  the user to pick one), then asks the backend to compose the answer. */
  delegation?: ChatDelegation;
}

export interface ChatDelegation {
  /** The model-rephrased work-summary task to answer from a fixed snapshot. */
  task: string;
  /** owner/name of the repo the question is about, when the model could
   *  identify one from context. Unset means "ask the user to pick". */
  repoFullName?: string;
  /** chat_messages.id of the placeholder row the backend should finalize
   *  once it composes the answer from the snapshot. */
  messageId: string;
}

export type ChatMessage = ChatUserMessage | ChatAssistantMessage;

export interface ChatAskRequest {
  messages: ChatMessage[];
  /** Stable ID grouping all turns of one conversation. Server generates one
   *  on the first turn and echoes it back; clients pass it on follow-ups so
   *  history shows them as a single thread. */
  threadId?: string;
}

export interface ChatAskResponse {
  message: ChatAssistantMessage;
  /** The thread this turn was persisted under (always set on success — even
   *  for first turns, where it was generated server-side). */
  threadId: string;
}

export type ChatWorkSnapshotGhStatus = "ready" | "missing" | "unauthed";

export interface ChatWorkSnapshotPr {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  headRef: string | null;
  baseRef: string | null;
  authorLogin: string | null;
  updatedAt: string | null;
}

/**
 * Deterministic desktop-collected context for delegated Ask answers. This is
 * intentionally metadata-only: no file contents, no arbitrary command output,
 * and no model-selected local tools. The backend treats all string fields as
 * untrusted data.
 */
export interface ChatWorkSnapshot {
  repo: {
    repoId: number;
    fullName: string;
  };
  collectedAt: string;
  branch: string | null;
  headSha: string | null;
  statusShort: string[];
  changedFiles: string[];
  diffStat: string | null;
  recentCommits: string[];
  relatedPrs: ChatWorkSnapshotPr[];
  ghStatus: ChatWorkSnapshotGhStatus;
  collectionErrors?: string[];
}

export interface ChatDelegatedWorkRequest {
  messageId: string;
  task: string;
  repoFullName: string;
  snapshot: ChatWorkSnapshot;
}

export interface ChatDelegatedWorkResponse {
  text: string;
  hadError: boolean;
}

/** One persisted user→assistant exchange, surfaced in history views. */
export interface ChatHistoryTurn {
  id: string;
  turnIndex: number;
  prompt: string;
  /** Assistant content with [session:...] citation tokens preserved. */
  answer: string;
  citations: ChatCitation[];
  createdAt: string;
}

/** A conversation grouped from chat_messages rows. Cards are hydrated from
 *  citations across all turns in the thread, deduped by sessionId, and
 *  scoped to the viewer's user_repos like everywhere else. */
export interface ChatThread {
  threadId: string;
  asker: {
    login: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  /** First user prompt — used as the thread title. */
  title: string;
  turns: ChatHistoryTurn[];
  cards: SessionCard[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatHistoryResponse {
  threads: ChatThread[];
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

/** Spotify "now playing" broadcast from a desktop client. Null clears. */
export interface SpotifyPresence {
  trackId: string;
  name: string;
  artist: string;
  /** https://open.spotify.com/track/<id> — safe to open in a browser. */
  url: string;
  isPlaying: boolean;
  /** ISO-8601. Server stamps this on write. */
  updatedAt: string;
}

/** "owner/name" → "name". Used in LLM prompts and UI labels — the basename
 *  is what users actually call the project ("slashtalk", not "owner/slashtalk").
 *  Returns the input unchanged when there's no slash. */
export function shortRepoName(fullName: string): string {
  const slash = fullName.lastIndexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}
