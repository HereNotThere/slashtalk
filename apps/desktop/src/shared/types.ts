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

export type Unsubscribe = () => void;

// slashtalk backend types
export interface BackendUser {
  githubLogin: string;
  avatarUrl: string;
  displayName: string | null;
}

export type BackendAuthState =
  | { signedIn: false }
  | { signedIn: true; user: BackendUser };

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

  // slashtalk backend
  backend: {
    getAuthState: () => Promise<BackendAuthState>;
    signIn: () => Promise<void>;
    cancelSignIn: () => Promise<void>;
    signOut: () => Promise<void>;
    onAuthState: (cb: (state: BackendAuthState) => void) => Unsubscribe;

    listRepos: () => Promise<RepoSummary[]>;

    listTrackedRepos: () => Promise<TrackedRepo[]>;
    /** Opens a folder picker, claims + tracks. Resolves `null` if cancelled;
     *  rejects with a user-facing message on any other failure. */
    addLocalRepo: () => Promise<TrackedRepo | null>;
    removeLocalRepo: (repoId: number) => Promise<TrackedRepo[]>;
    onTrackedReposChange: (cb: (repos: TrackedRepo[]) => void) => Unsubscribe;
  };
}

declare global {
  interface Window {
    chatheads: ChatHeadsBridge;
  }
}
