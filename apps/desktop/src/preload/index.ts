import { contextBridge, ipcRenderer } from "electron";
import type {
  BackendAuthState,
  ChatHead,
  ChatHeadsBridge,
  InfoSession,
  RailDebugSnapshot,
  RepoSummary,
  TrackedRepo,
  Unsubscribe,
} from "../shared/types";

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void =>
    cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

const bridge: ChatHeadsBridge = {
  list: () => ipcRenderer.invoke("heads:list") as Promise<ChatHead[]>,
  onUpdate: (cb) => subscribe<ChatHead[]>("heads:update", cb),

  showInfo: (index) =>
    ipcRenderer.invoke("heads:showInfo", index) as Promise<void>,
  infoHoverEnter: () =>
    ipcRenderer.invoke("info:hoverEnter") as Promise<void>,
  infoHoverLeave: () =>
    ipcRenderer.invoke("info:hoverLeave") as Promise<void>,

  toggleChat: () => ipcRenderer.invoke("chat:toggle") as Promise<void>,
  hideChat: () => ipcRenderer.invoke("chat:hide") as Promise<void>,
  onChatState: (cb) => subscribe<{ visible: boolean }>("chat:state", cb),
  onChatConfig: (cb) =>
    subscribe<{ anchor: "left" | "right" }>("chat:config", cb),

  openResponse: (message) =>
    ipcRenderer.invoke("response:open", message) as Promise<void>,
  onResponseOpen: (cb) => subscribe<{ message: string }>("response:open", cb),

  dragStart: () => ipcRenderer.invoke("drag:start") as Promise<void>,
  dragEnd: () => ipcRenderer.invoke("drag:end") as Promise<void>,

  onInfoShow: (cb) =>
    subscribe<{ head: ChatHead; sessions: InfoSession[] | null }>(
      "info:show",
      cb,
    ),
  onInfoHide: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on("info:hide", handler);
    return () => ipcRenderer.off("info:hide", handler);
  },
  hideInfo: () => ipcRenderer.invoke("info:hide") as Promise<void>,

  listSessionsForHead: (headId) =>
    ipcRenderer.invoke("sessions:forHead", headId) as Promise<InfoSession[]>,

  preloadSessions: (headId) =>
    ipcRenderer.invoke("sessions:preload", headId) as Promise<void>,

  openMain: () => ipcRenderer.invoke("app:openMain") as Promise<void>,
  quit: () => ipcRenderer.invoke("app:quit") as Promise<void>,

  copyText: (text) =>
    ipcRenderer.invoke("clipboard:writeText", text) as Promise<void>,
  openExternal: (url) =>
    ipcRenderer.invoke("shell:openExternal", url) as Promise<void>,

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

  debug: {
    railSnapshot: () =>
      ipcRenderer.invoke("debug:railSnapshot") as Promise<RailDebugSnapshot>,
    refreshRail: () =>
      ipcRenderer.invoke("debug:refreshRail") as Promise<RailDebugSnapshot>,
  },
};

contextBridge.exposeInMainWorld("chatheads", bridge);
