export type ClientInfo = { name?: string; version?: string };

export type UserProfile = { name?: string; avatar?: string; tz?: string };

export type Root = { uri: string; name?: string };

export type SessionInfo = {
  sessionId: string;
  connectedAt: number;
  lastActivity: number;
  clientInfo?: ClientInfo;
  roots?: Root[];
};

export type PresenceState = {
  userId: string;
  sessions: Map<string, SessionInfo>;
  connectedAt: number;
  lastActivity: number;
  name?: string;
  avatar?: string;
  tz?: string;
};

export type PresenceSnapshot = {
  userId: string;
  connectedAt: number;
  lastActivity: number;
  sessionCount: number;
  sessions: SessionInfo[];
  name?: string;
  avatar?: string;
  tz?: string;
};

export type PresenceEvent =
  | {
      type: "online";
      userId: string;
      connectedAt: number;
      clientInfo?: ClientInfo;
      name?: string;
      avatar?: string;
      tz?: string;
    }
  | { type: "offline"; userId: string }
  | {
      type: "activity";
      userId: string;
      lastActivity: number;
      sessionCount: number;
    };

type Listener = (event: PresenceEvent) => void;

export class McpPresenceStore {
  private states = new Map<string, PresenceState>();
  private listeners = new Set<Listener>();

  online(userId: string, sessionId: string, clientInfo?: ClientInfo, profile?: UserProfile): void {
    const now = Date.now();
    const session: SessionInfo = {
      sessionId,
      connectedAt: now,
      lastActivity: now,
      clientInfo,
    };

    const existing = this.states.get(userId);
    if (existing) {
      existing.sessions.set(sessionId, session);
      existing.lastActivity = now;
      if (profile?.name) existing.name = profile.name;
      if (profile?.avatar) existing.avatar = profile.avatar;
      if (profile?.tz) existing.tz = profile.tz;
      this.emit({
        type: "activity",
        userId,
        lastActivity: now,
        sessionCount: existing.sessions.size,
      });
      return;
    }

    const state: PresenceState = {
      userId,
      sessions: new Map([[sessionId, session]]),
      connectedAt: now,
      lastActivity: now,
      name: profile?.name,
      avatar: profile?.avatar,
      tz: profile?.tz,
    };
    this.states.set(userId, state);
    this.emit({
      type: "online",
      userId,
      connectedAt: now,
      clientInfo,
      name: profile?.name,
      avatar: profile?.avatar,
      tz: profile?.tz,
    });
  }

  touch(userId: string, sessionId?: string): void {
    const state = this.states.get(userId);
    if (!state) return;
    const now = Date.now();
    state.lastActivity = now;
    if (sessionId) {
      const session = state.sessions.get(sessionId);
      if (session) session.lastActivity = now;
    }
    this.emit({
      type: "activity",
      userId,
      lastActivity: now,
      sessionCount: state.sessions.size,
    });
  }

  setSessionRoots(userId: string, sessionId: string, roots: Root[]): void {
    const state = this.states.get(userId);
    if (!state) return;
    const session = state.sessions.get(sessionId);
    if (!session) return;
    session.roots = roots;
    this.emit({
      type: "activity",
      userId,
      lastActivity: state.lastActivity,
      sessionCount: state.sessions.size,
    });
  }

  offline(userId: string, sessionId: string): void {
    const state = this.states.get(userId);
    if (!state) return;
    state.sessions.delete(sessionId);
    if (state.sessions.size === 0) {
      this.states.delete(userId);
      this.emit({ type: "offline", userId });
    } else {
      this.emit({
        type: "activity",
        userId,
        lastActivity: state.lastActivity,
        sessionCount: state.sessions.size,
      });
    }
  }

  snapshot(): PresenceSnapshot[] {
    return [...this.states.values()].map((s) => ({
      userId: s.userId,
      connectedAt: s.connectedAt,
      lastActivity: s.lastActivity,
      sessionCount: s.sessions.size,
      sessions: [...s.sessions.values()],
      name: s.name,
      avatar: s.avatar,
      tz: s.tz,
    }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: PresenceEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        // A buggy listener must not break fan-out to peers.
        console.warn("[presence] listener threw:", (err as Error).message);
      }
    }
  }
}
