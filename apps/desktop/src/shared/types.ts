// Shared types used by main, preload, and all renderer windows.
// Any IPC contract lives here, so changes are caught by the compiler on both sides.

import type {
  ManagedAgentSessionRow,
  FeedSessionSnapshot,
  SessionSnapshot,
  SpotifyPresence,
} from "@slashtalk/shared";

// Re-export for convenience: renderers import from this module, not from
// @slashtalk/shared directly.
export type { ManagedAgentSessionRow, SpotifyPresence };

// Sessions surfaced to the info window: own sessions (SessionSnapshot) and
// peer sessions from /api/feed (FeedSessionSnapshot with extra social fields).
export type InfoSession = SessionSnapshot | FeedSessionSnapshot;

export type Avatar = { type: "emoji"; value: string } | { type: "remote"; value: string };

export interface ChatHead {
  id: string;
  /** Picks the info-popover layout and routes session fetches. */
  kind: "user" | "agent";
  label: string;
  tint: string;
  avatar: Avatar;
  /** Epoch ms of the most recent activity on this head. Optional for back-compat
   *  with persisted heads from before this field was added. */
  lastActionAt?: number;
  /** Epoch ms when this teammate's most recent PR opened/merged event landed.
   *  Renderer treats it as transient (animates while it's < a few seconds old). */
  prActivityAt?: number;
  /** Epoch ms of the most recent live-collision detection (this user is editing
   *  the same file as you right now). Transient — TTL'd by rail.ts. */
  collisionAt?: number;
  /** Path of the file in the most recent collision; pairs with collisionAt for
   *  the tooltip ("Editing src/auth.ts with you"). */
  collisionFile?: string;
  /** True when this user has at least one BUSY/ACTIVE session in the latest
   *  feed poll — i.e. they're "working now". Renders a pulsing blue ring around
   *  the bubble on the rail and suppresses the "last session" timestamp badge
   *  so the live state reads cleanly. */
  live?: boolean;
  /** Set when the agent streamed new content while its info panel was not
   *  open. Cleared when the user opens the panel. Agent heads only. */
  unread?: boolean;
}

export type Unsubscribe = () => void;

// Rail dock placement. `orientation` = which axis the rail runs along;
// `side` = which end of the perpendicular axis it's pinned to
// (start = top for horizontal / left for vertical, end = bottom / right).
export type DockOrientation = "vertical" | "horizontal";
export type DockSide = "start" | "end";
export interface DockConfig {
  orientation: DockOrientation;
  side: DockSide;
}

// slashtalk backend types
export interface BackendUser {
  githubLogin: string;
  avatarUrl: string;
  displayName: string | null;
}

export type BackendAuthState = { signedIn: false } | { signedIn: true; user: BackendUser };

export type UserLocation = { timezone: string | null; city: string | null };

export interface InfoShowPayload {
  head: ChatHead;
  sessions: InfoSession[] | null;
  /** Session the caller wants auto-expanded on open (e.g. from a chat card click). */
  expandSessionId?: string | null;
  spotify: SpotifyPresence | null;
  location: UserLocation | null;
  isSelf: boolean;
  /** PRs + Claude-composed standup for the head's user. Null while main's
   *  cache is cold; the next push lands when the parallel fetch settles.
   *  May also carry stale data from the previous open (stale-while-revalidate). */
  dashboard: InfoDashboardData | null;
  /** True between fetch-start and fetch-settle. Lets the renderer distinguish
   *  "loaded, genuinely empty" (show "Nothing shipped yet today.") from
   *  "still fetching, displayed data may be stale or null" (show shimmer).
   *  Set by main: true on the initial show push, false on the post-fetch push. */
  dashboardFetching: boolean;
}

/** Local `gh` CLI state at PR-fetch time. "ready" → prs is authoritative.
 *  "missing"/"unauthed" → prs is empty by definition; renderer shows an
 *  install/auth nudge instead of "No PRs in this window." */
export type GhStatus = "ready" | "missing" | "unauthed";

export interface InfoDashboardData {
  prs: import("@slashtalk/shared").UserPr[];
  standup: string | null;
  /** Self-mode signal: caller has no claimed `user_repos`. The renderer
   *  shows a "connect a repo" CTA instead of empty PR/standup placeholders. */
  noClaimedRepos: boolean;
  ghStatus: GhStatus;
}

// Signed-in identity for the MCP/agents shim. Token stays main-side.
export interface ChatHeadsUser {
  login: string;
  name: string;
  avatar: string;
}

export type ChatHeadsAuthState = { signedIn: false } | { signedIn: true; user: ChatHeadsUser };

export interface RepoSummary {
  repoId: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  permission: string;
  syncedAt: string | null;
}

export interface TrackedRepo {
  repoId: number;
  fullName: string;
  localPath: string;
}

export interface TeammateSummary {
  githubLogin: string;
  avatarUrl: string;
  totalSessions: number;
  activeSessions: number;
  repos: string[];
}

/** Diagnostic snapshot of the rail's last `/api/feed/users` attempt. */
export interface RailDebugSnapshot {
  /** ms since epoch of the last refresh attempt; null if never attempted. */
  at: number | null;
  /** Peers returned on the last successful fetch. Empty array means the
   *  server returned zero peers; null means the last attempt failed. */
  peers: TeammateSummary[] | null;
  /** Error message from the last failed attempt, or null on success. */
  error: string | null;
}

export interface McpRoot {
  uri: string;
  name?: string;
}

export interface McpSessionInfo {
  sessionId: string;
  connectedAt: number;
  lastActivity: number;
  clientInfo?: { name?: string; version?: string };
  roots?: McpRoot[];
}

export interface McpPresenceDetail {
  userId: string;
  name?: string;
  avatar?: string;
  tz?: string;
  connectedAt: number;
  lastActivity: number;
  sessionCount: number;
  sessions: McpSessionInfo[];
}

export type AgentMode = "cloud" | "local";
export type AgentVisibility = "private" | "team";

export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model: string;
  createdAt: number;
  mode?: AgentMode;
  cwd?: string;
  visibility?: AgentVisibility;
  mcpServers?: McpServerInput[];
}

export interface SessionUsage {
  input: number;
  output: number;
}

export interface AgentSessionSummary {
  id: string;
  createdAt: number;
  title?: string;
  tokens?: SessionUsage;
}

export interface McpServerInput {
  name: string;
  url: string;
}

export interface GithubPendingConnect {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
}

export type GithubConnectState =
  | { kind: "disconnected" }
  | { kind: "connecting"; pending: GithubPendingConnect }
  | { kind: "connected"; login?: string; scope: string }
  | { kind: "error"; message: string };

export interface CreateAgentInput {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  mcpServers?: McpServerInput[];
  mode?: AgentMode;
  cwd?: string;
  visibility?: AgentVisibility;
}

export interface UpdateAgentInput {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  mcpServers?: McpServerInput[];
  cwd?: string;
  visibility?: AgentVisibility;
}

export type AgentStreamEvent =
  | { kind: "text"; agentId: string; text: string }
  | { kind: "thinking"; agentId: string }
  | {
      kind: "tool_use";
      agentId: string;
      id: string;
      name: string;
      server?: string;
      input?: unknown;
    }
  | {
      kind: "tool_result";
      agentId: string;
      toolUseId: string;
      isError?: boolean;
      summary?: string;
    }
  | { kind: "phase"; agentId: string; label: string | null }
  | {
      kind: "usage";
      agentId: string;
      input: number;
      output: number;
    }
  | { kind: "done"; agentId: string; stopReason?: string }
  | { kind: "error"; agentId: string; message: string };

/** Streaming events from a chat-delegate run. Same shape as
 *  AgentStreamEvent but without `agentId` — chat-delegate runs aren't tied
 *  to a managed agent record; the {runId} in the envelope is enough. */
export type ChatDelegateEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      server?: string;
      input?: unknown;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      isError?: boolean;
      summary?: string;
    }
  | { kind: "phase"; label: string | null }
  | { kind: "usage"; input: number; output: number }
  | { kind: "done"; stopReason?: string }
  | { kind: "error"; message: string };

export interface DelegatedChatRequest {
  task: string;
  repoFullName?: string;
  threadId: string;
  messageId: string;
  resolvedRepoId?: number;
}

export type DelegatedChatResponse =
  | { kind: "ok"; text: string; hadError: boolean; ghAvailable: boolean }
  | { kind: "needs-repo"; candidates: TrackedRepo[] }
  | { kind: "error"; message: string };

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      server?: string;
      input?: unknown;
      status: "running" | "ok" | "error";
      resultSummary?: string;
    };

export type AgentMsg =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      blocks: AssistantBlock[];
      phase?: string | null;
      done: boolean;
    };

export interface AgentHistoryPage {
  msgs: AgentMsg[];
  nextCursor: string | null;
}

export type McpTarget = "claude-code" | "codex";
export type McpInstallMode = "local-proxy" | "legacy-bearer";

export interface McpInstallOptions {
  mode?: McpInstallMode;
}

export interface McpTargetState {
  installed: boolean;
  path: string;
}

export interface McpInstallStatus {
  claudeCode: McpTargetState;
  codex: McpTargetState;
}

export type ResponseOpenPayload =
  | { kind: "message"; message: string }
  | { kind: "agent"; agentId: string; sessionId: string }
  | { kind: "thread"; thread: import("@slashtalk/shared").ChatThread };

export type ThemeMode = "system" | "light" | "dark";

// The full preload → renderer API surface. Implemented in src/preload/index.ts,
// consumed by renderer code via `window.chatheads`.
export interface ChatHeadsBridge {
  // MCP/agent sign-in compatibility shim. Backed by slashtalk backend auth;
  // token itself never crosses the preload boundary.
  auth: {
    getState: () => Promise<ChatHeadsAuthState>;
    signIn: () => Promise<void>;
    cancelSignIn: () => Promise<void>;
    signOut: () => Promise<void>;
    onState: (cb: (state: ChatHeadsAuthState) => void) => Unsubscribe;
  };

  // MCP install into external AI clients.
  mcp: {
    install: (target: McpTarget, options?: McpInstallOptions) => Promise<McpTargetState>;
    uninstall: (target: McpTarget) => Promise<McpTargetState>;
    status: () => Promise<McpInstallStatus>;
    url: () => Promise<string>;
    detailForHead: (headId: string) => Promise<McpPresenceDetail | null>;
  };

  // GitHub OAuth Device Flow for agents using the GitHub MCP server.
  github: {
    isConfigured: () => Promise<boolean>;
    getState: () => Promise<GithubConnectState>;
    connect: () => Promise<GithubPendingConnect>;
    cancelConnect: () => Promise<void>;
    disconnect: () => Promise<void>;
    onState: (cb: (state: GithubConnectState) => void) => Unsubscribe;
  };

  // Anthropic Managed Agents and local Claude Agent SDK agents.
  agents: {
    isConfigured: () => Promise<boolean>;
    setApiKey: (key: string) => Promise<void>;
    clearApiKey: () => Promise<void>;
    onConfiguredChange: (cb: (configured: boolean) => void) => Unsubscribe;
    list: () => Promise<AgentSummary[]>;
    create: (input: CreateAgentInput) => Promise<AgentSummary>;
    update: (id: string, input: UpdateAgentInput) => Promise<AgentSummary>;
    remove: (id: string) => Promise<void>;
    send: (agentId: string, text: string, sessionId?: string | null) => Promise<void>;
    history: (
      agentId: string,
      sessionId?: string | null,
      cursor?: string | null,
    ) => Promise<AgentHistoryPage>;
    listSessions: (agentId: string) => Promise<AgentSessionSummary[]>;
    newSession: (agentId: string) => Promise<AgentSessionSummary>;
    selectSession: (agentId: string, sessionId: string) => Promise<void>;
    ensureSessionUsage: (agentId: string, sessionId: string) => Promise<void>;
    removeSession: (agentId: string, sessionId: string) => Promise<void>;
    popOut: (agentId: string, sessionId: string) => Promise<void>;
    onEvent: (cb: (event: AgentStreamEvent) => void) => Unsubscribe;
    onListChange: (cb: (agents: AgentSummary[]) => void) => Unsubscribe;
    onSessionsChange: (
      cb: (payload: { agentId: string; sessions: AgentSessionSummary[] }) => void,
    ) => Unsubscribe;
  };

  // Head state — derived from the social graph, not user-managed.
  list: () => Promise<ChatHead[]>;
  onUpdate: (cb: (heads: ChatHead[]) => void) => Unsubscribe;

  // Rail pin toggle. Pinned = always on top (default). Unpinned = rail acts
  // like a normal app window, on top only when Slashtalk is focused.
  // sessionOnlyMode: when on AND unpinned, the rail stays hidden until the
  // user has an active Claude Code session (or force-opens via the tray),
  // then auto-hides 15 min after the last session ends.
  rail: {
    getPinned: () => Promise<boolean>;
    setPinned: (pinned: boolean) => Promise<void>;
    onPinnedChange: (cb: (pinned: boolean) => void) => Unsubscribe;
    getSessionOnlyMode: () => Promise<boolean>;
    setSessionOnlyMode: (enabled: boolean) => Promise<void>;
    onSessionOnlyModeChange: (cb: (enabled: boolean) => void) => Unsubscribe;
    /** When on, peers idle past the inactivity threshold collapse into a
     *  hover-expanding stack at the bottom of the rail. Off by default so
     *  long-tail teams aren't hidden until the user opts in. */
    getCollapseInactive: () => Promise<boolean>;
    setCollapseInactive: (enabled: boolean) => Promise<void>;
    onCollapseInactiveChange: (cb: (enabled: boolean) => void) => Unsubscribe;
    /** When on, each chathead renders an "Xm/Xh/Xd" activity timestamp badge.
     *  Default on; tray toggle clears the badges to declutter the rail. */
    getShowActivityTimestamps: () => Promise<boolean>;
    setShowActivityTimestamps: (shown: boolean) => Promise<void>;
    onShowActivityTimestampsChange: (cb: (shown: boolean) => void) => Unsubscribe;
  };

  // Opt-in toggle for broadcasting the user's Spotify "Now Playing" to peers.
  // Off by default — flipping on triggers the macOS Automation permission
  // dialog. Non-macOS clients see isSupported = false.
  spotifyShare: {
    isSupported: () => Promise<boolean>;
    getEnabled: () => Promise<boolean>;
    setEnabled: (enabled: boolean) => Promise<void>;
    onEnabledChange: (cb: (enabled: boolean) => void) => Unsubscribe;
  };

  // Light/dark theme. "system" (default) follows the OS appearance; "light"
  // and "dark" force a specific palette across every Slashtalk window.
  theme: {
    getMode: () => Promise<ThemeMode>;
    setMode: (mode: ThemeMode) => Promise<void>;
    onModeChange: (cb: (mode: ThemeMode) => void) => Unsubscribe;
  };

  setUserLocation: (payload: UserLocation) => Promise<void>;

  // Info box (overlay → main). Show/hide are driven by hover; the rail keeps
  // the leave timer and asks main to hide after the user leaves the bubble
  // and doesn't re-enter the info panel. `infoHoverEnter/Leave` let the info
  // panel itself hold the window open while the cursor is over it.
  // Both axes of the bubble's screen-space top-left are reported so main can
  // align the popover against whichever axis matches the current dock.
  showInfo: (headId: string, bubbleScreen?: { x: number; y: number }) => Promise<void>;
  infoHoverEnter: () => Promise<void>;
  infoHoverLeave: () => Promise<void>;
  /** Renderer ack: the latest `info:show` payload has been committed and
   *  the inner content measured. `height` is the natural content height in
   *  CSS pixels. Main awaits this before repositioning the window so size +
   *  position land correctly on the first setBounds (no overflow-then-snap). */
  notifyInfoShowReady: (height: number) => void;
  /** Overlay subscribes so the inactive-peer stack can stay expanded while the
   *  info card is open even if the cursor leaves the rail. */
  onInfoState: (cb: (state: { visible: boolean; headId: string | null }) => void) => Unsubscribe;
  /** Renderer reports the rail's desired main-axis length (px) so main can
   *  size the BrowserWindow to the actual content — including the collapsed
   *  vs. expanded state of the inactive-peer stack. */
  setOverlayLength: (length: number) => Promise<void>;

  // Chat input (overlay ↔ main, chat renderer → main)
  toggleChat: () => Promise<void>;
  hideChat: () => Promise<void>;
  /** Overlay subscribes so it can hide the chat bubble while the pill is open. */
  onChatState: (cb: (state: { visible: boolean }) => void) => Unsubscribe;
  /** Overlay renderer subscribes to learn the current dock so it can swap
   *  flex direction / scroll axis / FLIP tracking. */
  onOverlayConfig: (cb: (cfg: DockConfig) => void) => Unsubscribe;

  // Response window (chat/agent pop-out → main → response)
  openResponse: (message: string) => Promise<void>;
  /** Open the Ask window with no seed — used by the dock search bubble. */
  showAsk: () => Promise<void>;
  onResponseOpen: (cb: (payload: ResponseOpenPayload) => void) => Unsubscribe;

  // Ask the backend chat endpoint. Client owns the full history. Pass the
  // threadId returned from a previous turn to keep follow-ups on one thread.
  askChat: (
    messages: import("@slashtalk/shared").ChatMessage[],
    threadId?: string,
  ) => Promise<import("@slashtalk/shared").ChatAskResponse>;

  // Caller's persisted Q&A threads, newest-first. Cards are pre-hydrated and
  // already gated by the caller's user_repos.
  fetchChatHistory: () => Promise<import("@slashtalk/shared").ChatHistoryResponse>;

  // Open a saved thread back up in the response window — used by the
  // "Recent questions" panel and the in-window history drawer.
  openThread: (thread: import("@slashtalk/shared").ChatThread) => Promise<void>;

  /** Open the info popover for the session owner represented by a chat card. */
  openSessionCard: (payload: { sessionId: string; login: string }) => Promise<void>;

  // LLM-picked "thinking state" phrases for the loading indicator, describing
  // what the assistant is actually doing for this specific prompt. The UI
  // cycles through them. Server guarantees a non-empty array.
  fetchChatGerunds: (prompt: string) => Promise<string[]>;

  // Chat delegation: server returned a ChatAssistantMessage with a `delegation`
  // field. Renderer hands the envelope here; main resolves the named repo to
  // a local cwd, runs a read-only Claude Agent SDK session, streams events
  // via onDelegatedEvent, and POSTs the final answer back to the server.
  runDelegatedChat: (req: DelegatedChatRequest) => Promise<DelegatedChatResponse>;
  onDelegatedEvent: (cb: (event: ChatDelegateEvent) => void) => Unsubscribe;

  // Drag (overlay → main)
  dragStart: () => Promise<void>;
  dragEnd: () => Promise<void>;

  // Info window (main → info renderer). Sessions are prefetched in main so
  // the renderer can paint in one pass at the correct height. `spotify` is
  // whatever the main-process peerPresence poller last saw for this head.
  // `location` is the head's persisted timezone+city (null until the user
  // has reported it). `isSelf` switches the renderer to local-resolve mode.
  onInfoShow: (cb: (payload: InfoShowPayload) => void) => Unsubscribe;
  onInfoHide: (cb: () => void) => Unsubscribe;
  /** Pushed from main when the currently-shown head's Spotify presence
   *  changes between polls. Scoped to the visible head already. */
  onInfoPresence: (
    cb: (payload: { login: string; spotify: SpotifyPresence | null }) => void,
  ) => Unsubscribe;
  hideInfo: () => Promise<void>;

  // Fetch sessions for a given chat head (self or a peer).
  listSessionsForHead: (headId: string) => Promise<InfoSession[]>;
  preloadSessions: (headId: string) => Promise<void>;
  listAgentSessionsForAgent: (agentId: string) => Promise<ManagedAgentSessionRow[]>;

  /** Latest cached Spotify presence for `login` from the main-process poller. */
  getSpotifyForLogin: (login: string) => Promise<SpotifyPresence | null>;

  // Tray popup actions
  openMain: () => Promise<void>;
  quit: () => Promise<void>;

  // System utilities
  copyText: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  selectDirectory: (defaultPath?: string) => Promise<string | null>;

  // Auto-size the calling window to the renderer's content height
  requestResize: (height: number) => Promise<void>;

  // slashtalk backend
  backend: {
    getAuthState: () => Promise<BackendAuthState>;
    signIn: () => Promise<void>;
    cancelSignIn: () => Promise<void>;
    signOut: () => Promise<void>;
    signOutEverywhere: () => Promise<void>;
    onAuthState: (cb: (state: BackendAuthState) => void) => Unsubscribe;

    listTrackedRepos: () => Promise<TrackedRepo[]>;
    /** Opens a folder picker, claims + tracks. Resolves `null` if cancelled;
     *  rejects with a user-facing message on any other failure. */
    addLocalRepo: () => Promise<TrackedRepo | null>;
    removeLocalRepo: (repoId: number) => Promise<TrackedRepo[]>;
    onTrackedReposChange: (cb: (repos: TrackedRepo[]) => void) => Unsubscribe;
  };

  // Tray-popup local-repo picker. Selection is a per-device filter on top of
  // the tracked-repo list — it only drives which peers appear on the chathead
  // rail (peers without a session in any selected repo drop off). Adding a
  // new tracked repo auto-selects it; removing one drops it from the set.
  trackedRepos: {
    selection: () => Promise<number[]>;
    toggle: (repoId: number) => Promise<number[]>;
    onSelectionChange: (cb: (selected: number[]) => void) => Unsubscribe;
  };

  collision: {
    /** Clear the persistent collision stamp on a teammate (their rail ring
     *  goes away, the popover banner self-hides). User-initiated only. */
    dismiss: (login: string) => Promise<void>;
  };

  debug: {
    railSnapshot: () => Promise<RailDebugSnapshot>;
    refreshRail: () => Promise<RailDebugSnapshot>;
    shuffleRail: () => Promise<void>;
    addFakeTeammate: () => Promise<void>;
    removeFakeTeammate: () => Promise<void>;
    replayEnterAnimation: () => Promise<void>;
    /** Synthesize a collision ping locally without needing another user to be
     *  editing the same file. Picks the first non-self peer (or a fake one if
     *  there are no real peers) and stamps a collision on them. */
    fireCollision: () => Promise<void>;
    /** Adds a fake teammate AND immediately fires a collision against them, so
     *  the full ring + chip animation is visible in one click. */
    fireCollisionOnFake: () => Promise<void>;
  };
  /** Dev-only: main fires this to ask the overlay to replay the enter
   *  animation on all currently mounted bubbles. */
  onDebugReplayEnter: (cb: () => void) => Unsubscribe;
}

declare global {
  interface Window {
    chatheads: ChatHeadsBridge;
  }
}
