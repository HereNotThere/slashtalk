import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SessionState,
  type FeedSessionSnapshot,
  type FeedUser,
  type StandupResponse,
  type SessionSnapshot,
  type TokenUsage,
  type UserPr,
  type UserPrsResponse,
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
  | {
      kind: "ready";
      me: Me;
      users: FeedUser[];
      sessions: FeedSessionSnapshot[];
      refreshedAt: number;
    }
  | { kind: "error"; message: string };

type DashboardState =
  | { kind: "loading" }
  | { kind: "ready"; standup: string | null; prs: UserPr[]; noClaimedRepos: boolean }
  | { kind: "error"; message: string };

const NOW_WINDOW_MS = 2 * 60 * 60 * 1000;

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
      setState({ kind: "ready", me, users, sessions, refreshedAt: Date.now() });
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

  return (
    <TeamNow
      me={state.me}
      users={state.users}
      sessions={state.sessions}
      refreshKey={state.refreshedAt}
      onRefresh={load}
    />
  );
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
  refreshKey,
  onRefresh,
}: {
  me: Me;
  users: FeedUser[];
  sessions: FeedSessionSnapshot[];
  refreshKey: number;
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
              refreshKey={refreshKey}
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
  refreshKey,
}: {
  login: string;
  user?: FeedUser;
  sessions: FeedSessionSnapshot[];
  refreshKey: number;
}): JSX.Element {
  const [dashboard, setDashboard] = useState<DashboardState>({ kind: "loading" });
  const nowSession = pickNowSession(sessions);
  const live = nowSession?.state === SessionState.BUSY || nowSession?.state === SessionState.ACTIVE;

  useEffect(() => {
    let cancelled = false;
    setDashboard((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    Promise.all([
      apiFetch<UserPrsResponse>(`/api/users/${encodeURIComponent(login)}/prs?scope=today`),
      apiFetch<StandupResponse>(`/api/users/${encodeURIComponent(login)}/standup?scope=today`),
    ])
      .then(([prsRes, standupRes]) => {
        if (cancelled) return;
        setDashboard({
          kind: "ready",
          standup: standupRes.summary,
          prs: prsRes.prs,
          noClaimedRepos: standupRes.noClaimedRepos === true || prsRes.noClaimedRepos === true,
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setDashboard({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [login, refreshKey]);

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
      {dashboard.kind === "ready" && dashboard.noClaimedRepos ? (
        <div className="card-section">
          <p className="muted">No repos connected yet.</p>
        </div>
      ) : (
        <>
          {nowSession ? <NowSection session={nowSession} /> : null}
          <TodaySection dashboard={dashboard} />
          <PrsSection dashboard={dashboard} />
        </>
      )}
    </article>
  );
}

function NowSection({ session }: { session: FeedSessionSnapshot }): JSX.Element {
  const status = sessionStatus(session);
  const tokens = fmtTokens(session.tokens);
  const summary = session.description;
  return (
    <section className="card-section">
      <SectionLabel label="Now" />
      <a className="now-link" href={`/app/sessions/${session.id}`}>
        <p className="now-summary">
          {summary ? summary : <span className="muted">Summarizing current session...</span>}
        </p>
        <div className="now-meta">
          <span>{repoName(session.repo_full_name)}</span>
          {tokens ? <span>{tokens} tokens</span> : null}
          {status ? (
            <span className={status.isLive ? "live-text" : undefined}>{status.text}</span>
          ) : null}
        </div>
      </a>
    </section>
  );
}

function TodaySection({ dashboard }: { dashboard: DashboardState }): JSX.Element {
  return (
    <section className="card-section">
      <SectionLabel label="Today" />
      <p className="today-copy">
        {dashboard.kind === "loading" ? (
          <span className="muted">Fetching...</span>
        ) : dashboard.kind === "error" ? (
          <span className="muted">Could not load today.</span>
        ) : dashboard.standup ? (
          <MarkdownInline text={dashboard.standup} />
        ) : (
          <span className="muted">Nothing shipped yet today.</span>
        )}
      </p>
    </section>
  );
}

function PrsSection({ dashboard }: { dashboard: DashboardState }): JSX.Element {
  const prs = dashboard.kind === "ready" ? dashboard.prs : null;
  return (
    <section className="card-section card-section-last">
      <SectionLabel label="PRs" />
      {dashboard.kind === "loading" ? (
        <p className="muted section-empty">Loading...</p>
      ) : dashboard.kind === "error" ? (
        <p className="muted section-empty">Could not load PRs.</p>
      ) : prs && prs.length > 0 ? (
        <div className="pr-list">
          {prs.slice(0, 4).map((pr) => (
            <PrRow key={`${pr.repoFullName}#${pr.number}`} pr={pr} />
          ))}
        </div>
      ) : (
        <p className="muted section-empty">No PRs in this window.</p>
      )}
    </section>
  );
}

function SectionLabel({ label }: { label: string }): JSX.Element {
  return <div className="section-label">{label}</div>;
}

function PrRow({ pr }: { pr: UserPr }): JSX.Element {
  return (
    <a className="pr-row" href={pr.url} target="_blank" rel="noreferrer">
      <div className={`pr-state pr-state-${pr.state}`} aria-hidden="true" />
      <div>
        <h3>{pr.title}</h3>
        <p>
          {repoName(pr.repoFullName)} #{pr.number} · {prStateLabel(pr.state)} ·{" "}
          {timeAgo(pr.updatedAt)}
        </p>
      </div>
    </a>
  );
}

function MarkdownInline({ text }: { text: string }): JSX.Element {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(<code key={index}>{token.slice(1, -1)}</code>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        parts.push(
          <a key={index} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        parts.push(token);
      }
    }
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function pickNowSession(sessions: FeedSessionSnapshot[]): FeedSessionSnapshot | null {
  const cutoff = Date.now() - NOW_WINDOW_MS;
  let bestLive: FeedSessionSnapshot | null = null;
  let bestLiveTs = -Infinity;
  let bestRecent: FeedSessionSnapshot | null = null;
  let bestRecentTs = -Infinity;

  for (const session of sessions) {
    const ts = session.lastTs ? new Date(session.lastTs).getTime() : 0;
    const isLive = session.state === SessionState.BUSY || session.state === SessionState.ACTIVE;
    if (isLive) {
      if (ts > bestLiveTs) {
        bestLiveTs = ts;
        bestLive = session;
      }
      continue;
    }

    if (session.state === SessionState.IDLE || session.state === SessionState.RECENT) {
      if (ts >= cutoff && ts > bestRecentTs) {
        bestRecentTs = ts;
        bestRecent = session;
      }
    }
  }

  return bestLive ?? bestRecent;
}

function sessionStatus(session: FeedSessionSnapshot): { text: string; isLive: boolean } | null {
  switch (session.state) {
    case SessionState.BUSY:
    case SessionState.ACTIVE:
      return { text: "working now", isLive: true };
    case SessionState.IDLE:
      return {
        text: session.idleS != null ? `idle ${fmtDuration(session.idleS)}` : "idle",
        isLive: false,
      };
    case SessionState.RECENT:
      return session.lastTs ? { text: `paused ${timeAgo(session.lastTs)}`, isLive: false } : null;
    case SessionState.ENDED:
      return session.lastTs ? { text: `ended ${timeAgo(session.lastTs)}`, isLive: false } : null;
  }
}

function fmtDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

function fmtTokens(tokens: TokenUsage | undefined): string | null {
  if (!tokens) return null;
  const total = tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
  if (total <= 0) return null;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${total}`;
}

function prStateLabel(state: UserPr["state"]): string {
  switch (state) {
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    case "merged":
      return "Merged";
  }
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
