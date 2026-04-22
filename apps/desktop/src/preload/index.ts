import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatHead,
  ChatHeadsBridge,
  GitHubOrg,
  GitHubPayload,
  GitHubUser,
  NewChatHead,
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
  spawn: (head: NewChatHead) =>
    ipcRenderer.invoke("heads:spawn", head) as Promise<ChatHead>,
  close: (id) => ipcRenderer.invoke("heads:close", id) as Promise<void>,
  list: () => ipcRenderer.invoke("heads:list") as Promise<ChatHead[]>,
  onUpdate: (cb) => subscribe<ChatHead[]>("heads:update", cb),

  toggleInfo: (index) =>
    ipcRenderer.invoke("heads:toggleInfo", index) as Promise<void>,

  dragStart: () => ipcRenderer.invoke("drag:start") as Promise<void>,
  dragEnd: () => ipcRenderer.invoke("drag:end") as Promise<void>,

  onInfoShow: (cb) => subscribe<{ label: string }>("info:show", cb),

  closeAll: () => ipcRenderer.invoke("heads:closeAll") as Promise<void>,
  openMain: () => ipcRenderer.invoke("app:openMain") as Promise<void>,
  quit: () => ipcRenderer.invoke("app:quit") as Promise<void>,

  copyText: (text) =>
    ipcRenderer.invoke("clipboard:writeText", text) as Promise<void>,
  openExternal: (url) =>
    ipcRenderer.invoke("shell:openExternal", url) as Promise<void>,

  github: {
    getState: () =>
      ipcRenderer.invoke("github:getState") as Promise<GitHubPayload>,
    startDeviceFlow: () =>
      ipcRenderer.invoke("github:startDeviceFlow") as Promise<void>,
    cancelDeviceFlow: () =>
      ipcRenderer.invoke("github:cancelDeviceFlow") as Promise<void>,
    signOut: () => ipcRenderer.invoke("github:signOut") as Promise<void>,
    listOrgs: () =>
      ipcRenderer.invoke("github:listOrgs") as Promise<GitHubOrg[]>,
    listMembers: (org) =>
      ipcRenderer.invoke("github:listMembers", org) as Promise<GitHubUser[]>,
    onState: (cb) => subscribe<GitHubPayload>("github:state", cb),
  },
};

contextBridge.exposeInMainWorld("chatheads", bridge);
