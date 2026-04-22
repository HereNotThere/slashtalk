// Shared types used by main, preload, and all renderer windows.
// Any IPC contract lives here, so changes are caught by the compiler on both sides.

import type { FeedSessionSnapshot, SessionSnapshot } from "@slashtalk/shared";

// Sessions surfaced to the info window: own sessions (SessionSnapshot) and
// peer sessions from /api/feed (FeedSessionSnapshot with extra social fields).
export type InfoSession = SessionSnapshot | FeedSessionSnapshot;

export type Avatar =
  | { type: 'emoji'; value: string }
  | { type: 'remote'; value: string };

export interface ChatHead {
  id: string;
  label: string;
  tint: string;
  avatar: Avatar;
  /** Epoch ms of the most recent activity on this head. Optional for back-compat
   *  with persisted heads from before this field was added. */
  lastActionAt?: number;
}

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

// The full preload → renderer API surface. Implemented in src/preload/index.ts,
// consumed by renderer code via `window.chatheads`.
export interface ChatHeadsBridge {
  // Head state — derived from the social graph, not user-managed.
  list: () => Promise<ChatHead[]>;
  onUpdate: (cb: (heads: ChatHead[]) => void) => Unsubscribe;

  // Info box (overlay → main)
  toggleInfo: (index: number) => Promise<void>;

  // Drag (overlay → main)
  dragStart: () => Promise<void>;
  dragEnd: () => Promise<void>;

  // Info window (main → info renderer)
  onInfoShow: (cb: (payload: { head: ChatHead }) => void) => Unsubscribe;
  onInfoHide: (cb: () => void) => Unsubscribe;

  // Fetch sessions for a given chat head (signed-in user's own or a peer's
  // that share a claimed repo with you).
  listSessionsForHead: (headId: string) => Promise<InfoSession[]>;

  // Tray popup actions
  openMain: () => Promise<void>;
  quit: () => Promise<void>;

  // System utilities
  copyText: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;

  // Auto-size the calling window to the renderer's content height
  requestResize: (height: number) => Promise<void>;

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

  debug: {
    railSnapshot: () => Promise<RailDebugSnapshot>;
    refreshRail: () => Promise<RailDebugSnapshot>;
  };
}

declare global {
  interface Window {
    chatheads: ChatHeadsBridge;
  }
}
