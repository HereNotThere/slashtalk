import { contextBridge, ipcRenderer } from "electron";
import type { ChatAskResponse, ChatMessage, SpotifyPresence } from "@slashtalk/shared";
import type {
  AgentHistoryPage,
  AgentSessionRow,
  AgentSessionSummary,
  AgentStreamEvent,
  AgentSummary,
  BackendAuthState,
  ChatAnchor,
  ChatHead,
  ChatHeadsAuthState,
  ChatHeadsBridge,
  CreateAgentInput,
  DockConfig,
  GithubConnectState,
  GithubPendingConnect,
  InfoSession,
  McpInstallStatus,
  McpPresenceDetail,
  McpTarget,
  McpTargetState,
  RailDebugSnapshot,
  ResponseOpenPayload,
  RepoSummary,
  TrackedRepo,
  Unsubscribe,
} from "../shared/types";
import type { OrgRepo, OrgSummary } from "@slashtalk/shared";

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void =>
    cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

const bridge: ChatHeadsBridge = {
  auth: {
    getState: () =>
      ipcRenderer.invoke("chatheads:getAuthState") as Promise<ChatHeadsAuthState>,
    signIn: () => ipcRenderer.invoke("chatheads:signIn") as Promise<void>,
    cancelSignIn: () =>
      ipcRenderer.invoke("chatheads:cancelSignIn") as Promise<void>,
    signOut: () => ipcRenderer.invoke("chatheads:signOut") as Promise<void>,
    onState: (cb) => subscribe<ChatHeadsAuthState>("chatheads:authState", cb),
  },

  mcp: {
    install: (target: McpTarget) =>
      ipcRenderer.invoke("mcp:install", target) as Promise<McpTargetState>,
    uninstall: (target: McpTarget) =>
      ipcRenderer.invoke("mcp:uninstall", target) as Promise<McpTargetState>,
    status: () => ipcRenderer.invoke("mcp:status") as Promise<McpInstallStatus>,
    url: () => ipcRenderer.invoke("mcp:url") as Promise<string>,
    detailForHead: (headId) =>
      ipcRenderer.invoke("mcp:detailForHead", headId) as Promise<McpPresenceDetail | null>,
  },

  github: {
    isConfigured: () =>
      ipcRenderer.invoke("github:isConfigured") as Promise<boolean>,
    getState: () =>
      ipcRenderer.invoke("github:getState") as Promise<GithubConnectState>,
    connect: () =>
      ipcRenderer.invoke("github:connect") as Promise<GithubPendingConnect>,
    cancelConnect: () =>
      ipcRenderer.invoke("github:cancelConnect") as Promise<void>,
    disconnect: () => ipcRenderer.invoke("github:disconnect") as Promise<void>,
    onState: (cb) => subscribe<GithubConnectState>("github:state", cb),
  },

  agents: {
    isConfigured: () =>
      ipcRenderer.invoke("agents:isConfigured") as Promise<boolean>,
    setApiKey: (key) =>
      ipcRenderer.invoke("agents:setApiKey", key) as Promise<void>,
    clearApiKey: () => ipcRenderer.invoke("agents:clearApiKey") as Promise<void>,
    onConfiguredChange: (cb) => subscribe<boolean>("agents:configured", cb),
    list: () => ipcRenderer.invoke("agents:list") as Promise<AgentSummary[]>,
    create: (input: CreateAgentInput) =>
      ipcRenderer.invoke("agents:create", input) as Promise<AgentSummary>,
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
      subscribe<{ agentId: string; sessions: AgentSessionSummary[] }>(
        "agents:sessionsChange",
        cb,
      ),
  },

  list: () => ipcRenderer.invoke("heads:list") as Promise<ChatHead[]>,
  onUpdate: (cb) => subscribe<ChatHead[]>("heads:update", cb),

  listProjects: () =>
    ipcRenderer.invoke("projects:list") as Promise<ChatHead[]>,
  onProjectsUpdate: (cb) => subscribe<ChatHead[]>("projects:update", cb),

  showInfo: (headId, bubbleScreen) =>
    ipcRenderer.invoke(
      "heads:showInfo",
      headId,
      bubbleScreen,
    ) as Promise<void>,
  infoHoverEnter: () =>
    ipcRenderer.invoke("info:hoverEnter") as Promise<void>,
  infoHoverLeave: () =>
    ipcRenderer.invoke("info:hoverLeave") as Promise<void>,

  toggleChat: () => ipcRenderer.invoke("chat:toggle") as Promise<void>,
  hideChat: () => ipcRenderer.invoke("chat:hide") as Promise<void>,
  onChatState: (cb) => subscribe<{ visible: boolean }>("chat:state", cb),
  onChatConfig: (cb) =>
    subscribe<{ anchor: ChatAnchor }>("chat:config", cb),
  onOverlayConfig: (cb) => subscribe<DockConfig>("overlay:config", cb),

  openResponse: (message) =>
    ipcRenderer.invoke("response:open", message) as Promise<void>,
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
    subscribe<{ login: string; spotify: SpotifyPresence | null }>(
      "info:presence",
      cb,
    ),
  hideInfo: () => ipcRenderer.invoke("info:hide") as Promise<void>,

  listSessionsForHead: (headId) =>
    ipcRenderer.invoke("sessions:forHead", headId) as Promise<InfoSession[]>,

  preloadSessions: (headId) =>
    ipcRenderer.invoke("sessions:preload", headId) as Promise<void>,

  listAgentSessionsForAgent: (agentId) =>
    ipcRenderer.invoke("agentSessions:forAgent", agentId) as Promise<
      AgentSessionRow[]
    >,

  getSpotifyForLogin: (login) =>
    ipcRenderer.invoke(
      "spotify:forLogin",
      login,
    ) as Promise<SpotifyPresence | null>,

  openMain: () => ipcRenderer.invoke("app:openMain") as Promise<void>,
  quit: () => ipcRenderer.invoke("app:quit") as Promise<void>,

  copyText: (text) =>
    ipcRenderer.invoke("clipboard:writeText", text) as Promise<void>,
  openExternal: (url) =>
    ipcRenderer.invoke("shell:openExternal", url) as Promise<void>,
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke("dialog:selectDirectory", defaultPath) as Promise<
      string | null
    >,

  requestResize: (height) =>
    ipcRenderer.invoke("window:requestResize", height) as Promise<void>,

  backend: {
    getAuthState: () =>
      ipcRenderer.invoke("backend:getAuthState") as Promise<BackendAuthState>,
    signIn: () => ipcRenderer.invoke("backend:signIn") as Promise<void>,
    cancelSignIn: () =>
      ipcRenderer.invoke("backend:cancelSignIn") as Promise<void>,
    signOut: () => ipcRenderer.invoke("backend:signOut") as Promise<void>,
    onAuthState: (cb) => subscribe<BackendAuthState>("backend:authState", cb),

    listRepos: () =>
      ipcRenderer.invoke("backend:listRepos") as Promise<RepoSummary[]>,

    listTrackedRepos: () =>
      ipcRenderer.invoke("backend:listTrackedRepos") as Promise<TrackedRepo[]>,
    addLocalRepo: () =>
      ipcRenderer.invoke("backend:addLocalRepo") as Promise<TrackedRepo | null>,
    removeLocalRepo: (repoId) =>
      ipcRenderer.invoke(
        "backend:removeLocalRepo",
        repoId,
      ) as Promise<TrackedRepo[]>,
    onTrackedReposChange: (cb) =>
      subscribe<TrackedRepo[]>("backend:trackedRepos", cb),
  },

  orgs: {
    list: () => ipcRenderer.invoke("orgs:list") as Promise<OrgSummary[]>,
    activeOrg: () =>
      ipcRenderer.invoke("orgs:activeOrg") as Promise<string | null>,
    setActive: (login) =>
      ipcRenderer.invoke("orgs:setActive", login) as Promise<void>,
    onListChange: (cb) => subscribe<OrgSummary[]>("orgs:listChange", cb),
    onActiveChange: (cb) => subscribe<string | null>("orgs:activeChange", cb),
  },

  repos: {
    listForActiveOrg: () =>
      ipcRenderer.invoke("repos:listForActiveOrg") as Promise<OrgRepo[]>,
    selection: () =>
      ipcRenderer.invoke("repos:selection") as Promise<string[]>,
    toggle: (fullName) =>
      ipcRenderer.invoke("repos:toggle", fullName) as Promise<string[]>,
    onUpdate: (cb) => subscribe<OrgRepo[]>("repos:update", cb),
    onSelectionChange: (cb) =>
      subscribe<string[]>("repos:selectionChange", cb),
  },

  debug: {
    railSnapshot: () =>
      ipcRenderer.invoke("debug:railSnapshot") as Promise<RailDebugSnapshot>,
    refreshRail: () =>
      ipcRenderer.invoke("debug:refreshRail") as Promise<RailDebugSnapshot>,
    shuffleRail: () =>
      ipcRenderer.invoke("debug:shuffleRail") as Promise<void>,
    addFakeTeammate: () =>
      ipcRenderer.invoke("debug:addFakeTeammate") as Promise<void>,
    removeFakeTeammate: () =>
      ipcRenderer.invoke("debug:removeFakeTeammate") as Promise<void>,
    replayEnterAnimation: () =>
      ipcRenderer.invoke("debug:replayEnterAnimation") as Promise<void>,
  },
  onDebugReplayEnter: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on("debug:replayEnter", handler);
    return () => ipcRenderer.off("debug:replayEnter", handler);
  },
};

contextBridge.exposeInMainWorld("chatheads", bridge);
