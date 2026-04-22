import { contextBridge, ipcRenderer } from "electron";
import type {
  BackendAuthState,
  ChatHead,
  ChatHeadsBridge,
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

  toggleInfo: (index) =>
    ipcRenderer.invoke("heads:toggleInfo", index) as Promise<void>,

  dragStart: () => ipcRenderer.invoke("drag:start") as Promise<void>,
  dragEnd: () => ipcRenderer.invoke("drag:end") as Promise<void>,

  onInfoShow: (cb) => subscribe<{ head: ChatHead }>("info:show", cb),

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
};

contextBridge.exposeInMainWorld("chatheads", bridge);
