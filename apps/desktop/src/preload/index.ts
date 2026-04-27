import { contextBridge, ipcRenderer } from "electron";
import type { ChatAskResponse, ChatMessage, SpotifyPresence } from "@slashtalk/shared";
import type {
  AgentHistoryPage,
  ManagedAgentSessionRow,
  AgentSessionSummary,
  AgentStreamEvent,
  AgentSummary,
  BackendAuthState,
  ChatHead,
  ChatHeadsAuthState,
  ChatHeadsBridge,
  CreateAgentInput,
  DockConfig,
  GithubConnectState,
  GithubAppStatus,
  GithubPendingConnect,
  InfoSession,
  McpInstallStatus,
  McpInstallOptions,
  McpPresenceDetail,
  McpTarget,
  McpTargetState,
  RailDebugSnapshot,
  ResponseOpenPayload,
  TrackedRepo,
  Unsubscribe,
  UpdateAgentInput,
} from "../shared/types";

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

const bridge: ChatHeadsBridge = {
  auth: {
    getState: () => ipcRenderer.invoke("chatheads:getAuthState") as Promise<ChatHeadsAuthState>,
    signIn: () => ipcRenderer.invoke("chatheads:signIn") as Promise<void>,
    cancelSignIn: () => ipcRenderer.invoke("chatheads:cancelSignIn") as Promise<void>,
    signOut: () => ipcRenderer.invoke("chatheads:signOut") as Promise<void>,
    onState: (cb) => subscribe<ChatHeadsAuthState>("chatheads:authState", cb),
  },

  mcp: {
    install: (target: McpTarget, options?: McpInstallOptions) =>
      ipcRenderer.invoke("mcp:install", target, options) as Promise<McpTargetState>,
    uninstall: (target: McpTarget) =>
      ipcRenderer.invoke("mcp:uninstall", target) as Promise<McpTargetState>,
    status: () => ipcRenderer.invoke("mcp:status") as Promise<McpInstallStatus>,
    url: () => ipcRenderer.invoke("mcp:url") as Promise<string>,
    detailForHead: (headId) =>
      ipcRenderer.invoke("mcp:detailForHead", headId) as Promise<McpPresenceDetail | null>,
  },

  github: {
    isConfigured: () => ipcRenderer.invoke("github:isConfigured") as Promise<boolean>,
    getState: () => ipcRenderer.invoke("github:getState") as Promise<GithubConnectState>,
    connect: () => ipcRenderer.invoke("github:connect") as Promise<GithubPendingConnect>,
    cancelConnect: () => ipcRenderer.invoke("github:cancelConnect") as Promise<void>,
    disconnect: () => ipcRenderer.invoke("github:disconnect") as Promise<void>,
    onState: (cb) => subscribe<GithubConnectState>("github:state", cb),
  },

  agents: {
    isConfigured: () => ipcRenderer.invoke("agents:isConfigured") as Promise<boolean>,
    setApiKey: (key) => ipcRenderer.invoke("agents:setApiKey", key) as Promise<void>,
    clearApiKey: () => ipcRenderer.invoke("agents:clearApiKey") as Promise<void>,
    onConfiguredChange: (cb) => subscribe<boolean>("agents:configured", cb),
    list: () => ipcRenderer.invoke("agents:list") as Promise<AgentSummary[]>,
    create: (input: CreateAgentInput) =>
      ipcRenderer.invoke("agents:create", input) as Promise<AgentSummary>,
    update: (id, input: UpdateAgentInput) =>
      ipcRenderer.invoke("agents:update", id, input) as Promise<AgentSummary>,
    remove: (id) => ipcRenderer.invoke("agents:remove", id) as Promise<void>,
    send: (agentId, text, sessionId) =>
      ipcRenderer.invoke("agents:send", agentId, text, sessionId) as Promise<void>,
    history: (agentId, sessionId, cursor) =>
      ipcRenderer.invoke("agents:history", agentId, sessionId, cursor) as Promise<AgentHistoryPage>,
    listSessions: (agentId) =>
      ipcRenderer.invoke("agents:listSessions", agentId) as Promise<AgentSessionSummary[]>,
    newSession: (agentId) =>
      ipcRenderer.invoke("agents:newSession", agentId) as Promise<AgentSessionSummary>,
    selectSession: (agentId, sessionId) =>
      ipcRenderer.invoke("agents:selectSession", agentId, sessionId) as Promise<void>,
    ensureSessionUsage: (agentId, sessionId) =>
      ipcRenderer.invoke("agents:ensureSessionUsage", agentId, sessionId) as Promise<void>,
    removeSession: (agentId, sessionId) =>
      ipcRenderer.invoke("agents:removeSession", agentId, sessionId) as Promise<void>,
    popOut: (agentId, sessionId) =>
      ipcRenderer.invoke("agents:popOut", agentId, sessionId) as Promise<void>,
    onEvent: (cb) => subscribe<AgentStreamEvent>("agents:event", cb),
    onListChange: (cb) => subscribe<AgentSummary[]>("agents:listChange", cb),
    onSessionsChange: (cb) =>
      subscribe<{ agentId: string; sessions: AgentSessionSummary[] }>("agents:sessionsChange", cb),
  },

  list: () => ipcRenderer.invoke("heads:list") as Promise<ChatHead[]>,
  onUpdate: (cb) => subscribe<ChatHead[]>("heads:update", cb),

  rail: {
    getPinned: () => ipcRenderer.invoke("rail:getPinned") as Promise<boolean>,
    setPinned: (pinned: boolean) => ipcRenderer.invoke("rail:setPinned", pinned) as Promise<void>,
    onPinnedChange: (cb) => subscribe<boolean>("rail:pinned", cb),
    getSessionOnlyMode: () => ipcRenderer.invoke("rail:getSessionOnlyMode") as Promise<boolean>,
    setSessionOnlyMode: (enabled: boolean) =>
      ipcRenderer.invoke("rail:setSessionOnlyMode", enabled) as Promise<void>,
    onSessionOnlyModeChange: (cb) => subscribe<boolean>("rail:sessionOnlyMode", cb),
    getCollapseInactive: () => ipcRenderer.invoke("rail:getCollapseInactive") as Promise<boolean>,
    setCollapseInactive: (enabled: boolean) =>
      ipcRenderer.invoke("rail:setCollapseInactive", enabled) as Promise<void>,
    onCollapseInactiveChange: (cb) => subscribe<boolean>("rail:collapseInactive", cb),
    getShowActivityTimestamps: () =>
      ipcRenderer.invoke("rail:getShowActivityTimestamps") as Promise<boolean>,
    setShowActivityTimestamps: (shown: boolean) =>
      ipcRenderer.invoke("rail:setShowActivityTimestamps", shown) as Promise<void>,
    onShowActivityTimestampsChange: (cb) => subscribe<boolean>("rail:showActivityTimestamps", cb),
  },

  spotifyShare: {
    isSupported: () => ipcRenderer.invoke("spotify:isSupported") as Promise<boolean>,
    getEnabled: () => ipcRenderer.invoke("spotify:getShareEnabled") as Promise<boolean>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("spotify:setShareEnabled", enabled) as Promise<void>,
    onEnabledChange: (cb) => subscribe<boolean>("spotify:shareEnabled", cb),
  },

  showInfo: (headId, bubbleScreen) =>
    ipcRenderer.invoke("heads:showInfo", headId, bubbleScreen) as Promise<void>,
  infoHoverEnter: () => ipcRenderer.invoke("info:hoverEnter") as Promise<void>,
  infoHoverLeave: () => ipcRenderer.invoke("info:hoverLeave") as Promise<void>,
  onInfoState: (cb) => subscribe<{ visible: boolean; headId: string | null }>("info:state", cb),
  setOverlayLength: (length) => ipcRenderer.invoke("overlay:setLength", length) as Promise<void>,

  toggleChat: () => ipcRenderer.invoke("chat:toggle") as Promise<void>,
  hideChat: () => ipcRenderer.invoke("chat:hide") as Promise<void>,
  onChatState: (cb) => subscribe<{ visible: boolean }>("chat:state", cb),
  onOverlayConfig: (cb) => subscribe<DockConfig>("overlay:config", cb),
  openAgentCreator: () => ipcRenderer.invoke("app:openAgentCreator") as Promise<void>,
  onOpenAgentCreator: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on("agents:openCreator", handler);
    return () => ipcRenderer.off("agents:openCreator", handler);
  },

  openResponse: (message) => ipcRenderer.invoke("response:open", message) as Promise<void>,
  onResponseOpen: (cb) => subscribe<ResponseOpenPayload>("response:open", cb),

  askChat: (messages: ChatMessage[]) =>
    ipcRenderer.invoke("chat:ask", messages) as Promise<ChatAskResponse>,

  openSessionCard: (payload) =>
    ipcRenderer.invoke("chat:openSessionCard", payload) as Promise<void>,

  fetchChatGerunds: (prompt: string) =>
    ipcRenderer.invoke("chat:gerund", prompt) as Promise<string[]>,

  dragStart: () => ipcRenderer.invoke("drag:start") as Promise<void>,
  dragEnd: () => ipcRenderer.invoke("drag:end") as Promise<void>,

  onInfoShow: (cb) =>
    subscribe<{
      head: ChatHead;
      sessions: InfoSession[] | null;
      expandSessionId?: string | null;
      spotify: SpotifyPresence | null;
    }>("info:show", cb),
  onInfoHide: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on("info:hide", handler);
    return () => ipcRenderer.off("info:hide", handler);
  },
  onInfoPresence: (cb) =>
    subscribe<{ login: string; spotify: SpotifyPresence | null }>("info:presence", cb),
  hideInfo: () => ipcRenderer.invoke("info:hide") as Promise<void>,

  listSessionsForHead: (headId) =>
    ipcRenderer.invoke("sessions:forHead", headId) as Promise<InfoSession[]>,

  preloadSessions: (headId) => ipcRenderer.invoke("sessions:preload", headId) as Promise<void>,

  listAgentSessionsForAgent: (agentId) =>
    ipcRenderer.invoke("agentSessions:forAgent", agentId) as Promise<ManagedAgentSessionRow[]>,

  getSpotifyForLogin: (login) =>
    ipcRenderer.invoke("spotify:forLogin", login) as Promise<SpotifyPresence | null>,

  openMain: () => ipcRenderer.invoke("app:openMain") as Promise<void>,
  quit: () => ipcRenderer.invoke("app:quit") as Promise<void>,

  copyText: (text) => ipcRenderer.invoke("clipboard:writeText", text) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url) as Promise<void>,
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke("dialog:selectDirectory", defaultPath) as Promise<string | null>,

  requestResize: (height) => ipcRenderer.invoke("window:requestResize", height) as Promise<void>,

  backend: {
    getAuthState: () => ipcRenderer.invoke("backend:getAuthState") as Promise<BackendAuthState>,
    signIn: () => ipcRenderer.invoke("backend:signIn") as Promise<void>,
    cancelSignIn: () => ipcRenderer.invoke("backend:cancelSignIn") as Promise<void>,
    signOut: () => ipcRenderer.invoke("backend:signOut") as Promise<void>,
    signOutEverywhere: () => ipcRenderer.invoke("backend:signOutEverywhere") as Promise<void>,
    onAuthState: (cb) => subscribe<BackendAuthState>("backend:authState", cb),
    getGithubAppStatus: () =>
      ipcRenderer.invoke("backend:getGithubAppStatus") as Promise<GithubAppStatus>,
    connectGithubApp: () => ipcRenderer.invoke("backend:connectGithubApp") as Promise<void>,

    listTrackedRepos: () =>
      ipcRenderer.invoke("backend:listTrackedRepos") as Promise<TrackedRepo[]>,
    addLocalRepo: () => ipcRenderer.invoke("backend:addLocalRepo") as Promise<TrackedRepo | null>,
    removeLocalRepo: (repoId) =>
      ipcRenderer.invoke("backend:removeLocalRepo", repoId) as Promise<TrackedRepo[]>,
    onTrackedReposChange: (cb) => subscribe<TrackedRepo[]>("backend:trackedRepos", cb),
  },

  trackedRepos: {
    selection: () => ipcRenderer.invoke("trackedRepos:selection") as Promise<number[]>,
    toggle: (repoId) => ipcRenderer.invoke("trackedRepos:toggle", repoId) as Promise<number[]>,
    onSelectionChange: (cb) => subscribe<number[]>("trackedRepos:selectionChange", cb),
  },

  collision: {
    dismiss: (login) => ipcRenderer.invoke("collision:dismiss", login) as Promise<void>,
  },

  debug: {
    railSnapshot: () => ipcRenderer.invoke("debug:railSnapshot") as Promise<RailDebugSnapshot>,
    refreshRail: () => ipcRenderer.invoke("debug:refreshRail") as Promise<RailDebugSnapshot>,
    shuffleRail: () => ipcRenderer.invoke("debug:shuffleRail") as Promise<void>,
    addFakeTeammate: () => ipcRenderer.invoke("debug:addFakeTeammate") as Promise<void>,
    removeFakeTeammate: () => ipcRenderer.invoke("debug:removeFakeTeammate") as Promise<void>,
    replayEnterAnimation: () => ipcRenderer.invoke("debug:replayEnterAnimation") as Promise<void>,
    fireCollision: () => ipcRenderer.invoke("debug:fireCollision") as Promise<void>,
    fireCollisionOnFake: () => ipcRenderer.invoke("debug:fireCollisionOnFake") as Promise<void>,
  },
  onDebugReplayEnter: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on("debug:replayEnter", handler);
    return () => ipcRenderer.off("debug:replayEnter", handler);
  },
};

contextBridge.exposeInMainWorld("chatheads", bridge);
