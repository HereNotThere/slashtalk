import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SessionState,
  type FeedSessionSnapshot,
  type FeedUser,
  type SessionSnapshot,
} from "@slashtalk/shared";

interface Me {
  id: number;
  githubLogin: string;
  avatarUrl: string | null;
  displayName: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "ready"; me: Me; users: FeedUser[]; sessions: FeedSessionSnapshot[] }
  | { kind: "error"; message: string };

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return (await res.json()) as T;
}

class AuthError extends Error {
  constructor() {
    super("signed out");
  }
}

function signIn(): void {
  window.location.assign(`/auth/github?return_to=${encodeURIComponent("/app/")}`);
}

function stateLabel(state: FeedSessionSnapshot["state"]): string {
  switch (state) {
    case SessionState.BUSY:
      return "Busy";
    case SessionState.ACTIVE:
      return "Active";
    case SessionState.IDLE:
      return "Idle";
    case SessionState.RECENT:
      return "Recent";
    case SessionState.ENDED:
      return "Ended";
  }
}

function timeAgo(value: string | null): string {
  if (!value) return "No activity yet";
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function repoName(fullName: string | null): string {
  return fullName?.split("/").pop() || "Unmatched repo";
}

export default function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const selectedSessionId = selectedSessionFromPath();

  const load = useCallback(async () => {
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    try {
      const [me, users, sessions] = await Promise.all([
        apiFetch<Me>("/api/me/"),
        apiFetch<FeedUser[]>("/api/feed/users"),
        apiFetch<FeedSessionSnapshot[]>("/api/feed"),
      ]);
      setState({ kind: "ready", me, users, sessions });
    } catch (err) {
      if (err instanceof AuthError) {
        setState({ kind: "signed-out" });
        return;
      }
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const url = new URL("/ws", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type?: string };
        if (
          msg.type === "session_updated" ||
          msg.type === "session_insights_updated" ||
          msg.type === "collision_detected" ||
          msg.type === "pr_activity"
        ) {
          void load();
        }
      } catch {
        // Ignore malformed or future messages.
      }
    });
    return () => ws.close(1000, "app unmounted");
  }, [load, state.kind]);

  if (state.kind === "loading")
    return <Shell title="Slashtalk" detail="Loading team presence..." />;
  if (state.kind === "signed-out") {
    return (
      <Shell title="Slashtalk" detail="Sign in to see your team's live sessions.">
        <button className="primary" onClick={signIn}>
          Sign in with GitHub
        </button>
      </Shell>
    );
  }
  if (state.kind === "error") {
    return (
      <Shell title="Slashtalk" detail={state.message}>
        <button className="secondary" onClick={() => void load()}>
          Retry
        </button>
      </Shell>
    );
  }

  if (selectedSessionId) {
    return (
      <SessionDetail sessionId={selectedSessionId} onBack={() => window.location.assign("/app/")} />
    );
  }

  return <TeamNow me={state.me} users={state.users} sessions={state.sessions} onRefresh={load} />;
}

function Shell({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <main className="center-shell">
      <img src="/app/icons/icon.svg" alt="" className="app-icon" />
      <h1>{title}</h1>
      <p>{detail}</p>
      {children ? <div className="actions">{children}</div> : null}
    </main>
  );
}

function TeamNow({
  me,
  users,
  sessions,
  onRefresh,
}: {
  me: Me;
  users: FeedUser[];
  sessions: FeedSessionSnapshot[];
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const liveCount = sessions.filter(
    (s) => s.state === SessionState.BUSY || s.state === SessionState.ACTIVE,
  ).length;
  const usersByLogin = useMemo(() => {
    const map = new Map(users.map((u) => [u.github_login, u]));
    map.set(me.githubLogin, {
      github_login: me.githubLogin,
      avatar_url: me.avatarUrl,
      total_sessions: sessions.filter((s) => s.github_login === me.githubLogin).length,
      active_sessions: sessions.filter(
        (s) =>
          s.github_login === me.githubLogin &&
          (s.state === SessionState.BUSY || s.state === SessionState.ACTIVE),
      ).length,
      repos: [],
    });
    return map;
  }, [me, sessions, users]);

  const grouped = useMemo(() => {
    const out = new Map<string, FeedSessionSnapshot[]>();
    for (const session of sessions) {
      const existing = out.get(session.github_login);
      if (existing) existing.push(session);
      else out.set(session.github_login, [session]);
    }
    return [...out.entries()].sort((a, b) => latestTs(b[1]) - latestTs(a[1]));
  }, [sessions]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Team Now</div>
          <h1>Slashtalk</h1>
        </div>
        <div className="topbar-actions">
          <div className="signed-in">
            <Avatar src={me.avatarUrl} login={me.githubLogin} />
            <span>@{me.githubLogin}</span>
          </div>
          <button className="secondary" onClick={() => void onRefresh()}>
            Refresh
          </button>
        </div>
      </header>

      <section className="summary-grid" aria-label="Summary">
        <Metric label="Live sessions" value={liveCount} />
        <Metric label="Visible teammates" value={users.length} />
        <Metric label="Sessions loaded" value={sessions.length} />
      </section>

      <section className="people-list" aria-label="Teammates">
        {grouped.length === 0 ? (
          <div className="empty-state">
            <h2>No shared sessions yet</h2>
            <p>Claim a repo in the desktop app or through the repo picker when it lands here.</p>
          </div>
        ) : (
          grouped.map(([login, userSessions]) => (
            <PersonCard
              key={login}
              login={login}
              user={usersByLogin.get(login)}
              sessions={userSessions}
            />
          ))
        )}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PersonCard({
  login,
  user,
  sessions,
}: {
  login: string;
  user?: FeedUser;
  sessions: FeedSessionSnapshot[];
}): JSX.Element {
  const live = sessions.some(
    (s) => s.state === SessionState.BUSY || s.state === SessionState.ACTIVE,
  );
  return (
    <article className="person-card">
      <header className="person-header">
        <div className="person-title">
          <Avatar src={user?.avatar_url ?? null} login={login} />
          <div>
            <h2>@{login}</h2>
            <p>{live ? "Working now" : `Last active ${timeAgo(sessions[0]?.lastTs ?? null)}`}</p>
          </div>
        </div>
        <span className={live ? "status live" : "status"}>{live ? "Live" : "Quiet"}</span>
      </header>
      <div className="session-list">
        {sessions.slice(0, 4).map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
      </div>
    </article>
  );
}

function SessionRow({ session }: { session: FeedSessionSnapshot }): JSX.Element {
  return (
    <a className="session-row" href={`/app/sessions/${session.id}`}>
      <div>
        <h3>{session.title || session.lastUserPrompt || "Untitled session"}</h3>
        <p>
          {repoName(session.repo_full_name)}
          {session.branch ? ` · ${session.branch}` : ""}
        </p>
      </div>
      <div className="session-meta">
        <span className={`state state-${session.state}`}>{stateLabel(session.state)}</span>
        <span>{timeAgo(session.lastTs)}</span>
      </div>
    </a>
  );
}

function SessionDetail({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}): JSX.Element {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setError(null);
    apiFetch<SessionSnapshot>(`/api/session/${encodeURIComponent(sessionId)}`)
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <button className="link-button" onClick={onBack}>
            Back to Team Now
          </button>
          <h1>{session?.title || "Session detail"}</h1>
        </div>
      </header>

      {error ? (
        <div className="empty-state">
          <h2>Could not load session</h2>
          <p>{error}</p>
        </div>
      ) : !session ? (
        <div className="empty-state">
          <h2>Loading session</h2>
          <p>Fetching the latest snapshot.</p>
        </div>
      ) : (
        <article className="detail-grid">
          <section className="detail-main">
            <div className="detail-heading">
              <span className={`state state-${session.state}`}>{stateLabel(session.state)}</span>
              <span>{timeAgo(session.lastTs)}</span>
            </div>
            <p className="detail-summary">
              {session.description ||
                session.rollingSummary ||
                session.lastUserPrompt ||
                "No summary yet."}
            </p>
            <h2>Recent prompts</h2>
            {session.recentPrompts.length === 0 ? (
              <p className="muted">No prompts captured yet.</p>
            ) : (
              <ul className="plain-list">
                {session.recentPrompts.slice(0, 6).map((prompt) => (
                  <li key={`${prompt.ts}:${prompt.text}`}>
                    <span>{timeAgo(prompt.ts)}</span>
                    <p>{prompt.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <aside className="detail-side">
            <Fact label="Model" value={session.model || "Unknown"} />
            <Fact label="Branch" value={session.branch || "Unknown"} />
            <Fact label="Tool calls" value={String(session.toolCalls)} />
            <Fact label="Tokens" value={String(totalTokens(session))} />
            <Fact label="Current tool" value={session.currentTool?.name || "None"} />
          </aside>
        </article>
      )}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Avatar({ src, login }: { src: string | null | undefined; login: string }): JSX.Element {
  if (src) return <img className="avatar" src={src} alt="" />;
  return (
    <div className="avatar avatar-fallback" aria-hidden="true">
      {login.slice(0, 1).toUpperCase()}
    </div>
  );
}

function latestTs(sessions: FeedSessionSnapshot[]): number {
  let latest = 0;
  for (const session of sessions) {
    if (!session.lastTs) continue;
    latest = Math.max(latest, new Date(session.lastTs).getTime());
  }
  return latest;
}

function selectedSessionFromPath(): string | null {
  const match = window.location.pathname.match(/^\/app\/sessions\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function totalTokens(session: SessionSnapshot): number {
  return (
    session.tokens.in +
    session.tokens.out +
    session.tokens.cacheRead +
    session.tokens.cacheWrite +
    session.tokens.reasoning
  );
}
