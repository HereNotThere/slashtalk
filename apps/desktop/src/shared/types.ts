// Shared types used by main, preload, and all renderer windows.
// Any IPC contract lives here, so changes are caught by the compiler on both sides.

export type Avatar =
  | { type: 'emoji'; value: string }
  | { type: 'remote'; value: string };

export interface ChatHead {
  id: string;
  label: string;
  tint: string;
  avatar: Avatar;
}

export type NewChatHead = Omit<ChatHead, 'id'>;

// GitHub auth state — mirrors GitHubAuth.State in Swift.
export type GitHubState =
  | { kind: 'signedOut' }
  | { kind: 'awaitingUserCode'; userCode: string; verificationURL: string }
  | { kind: 'signedIn' };

export interface GitHubPayload {
  state: GitHubState;
  errorMessage: string | null;
}

export interface GitHubOrg {
  id: number;
  login: string;
  avatarURL: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  avatarURL: string;
}

export type Unsubscribe = () => void;

// The full preload → renderer API surface. Implemented in src/preload/index.ts,
// consumed by renderer code via `window.chatheads`.
export interface ChatHeadsBridge {
  // Head state
  spawn: (head: NewChatHead) => Promise<ChatHead>;
  close: (id: string) => Promise<void>;
  list: () => Promise<ChatHead[]>;
  onUpdate: (cb: (heads: ChatHead[]) => void) => Unsubscribe;

  // Info box (overlay → main)
  toggleInfo: (index: number) => Promise<void>;

  // Drag (overlay → main)
  dragStart: () => Promise<void>;
  dragEnd: () => Promise<void>;

  // Info window (main → info renderer)
  onInfoShow: (cb: (payload: { label: string }) => void) => Unsubscribe;

  // Tray popup actions
  closeAll: () => Promise<void>;
  openMain: () => Promise<void>;
  quit: () => Promise<void>;

  // System utilities
  copyText: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;

  // GitHub
  github: {
    getState: () => Promise<GitHubPayload>;
    startDeviceFlow: () => Promise<void>;
    cancelDeviceFlow: () => Promise<void>;
    signOut: () => Promise<void>;
    listOrgs: () => Promise<GitHubOrg[]>;
    listMembers: (org: string) => Promise<GitHubUser[]>;
    onState: (cb: (payload: GitHubPayload) => void) => Unsubscribe;
  };
}

declare global {
  interface Window {
    chatheads: ChatHeadsBridge;
  }
}
