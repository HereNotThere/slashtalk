import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, FeedSessionSnapshot, FeedUser } from "@slashtalk/shared";
import {
  AuthError,
  askChat,
  fetchFeed,
  fetchFeedUsers,
  fetchGerunds,
  fetchMe,
  type Me,
} from "./lib/api";
import { buildCarouselHeads } from "./lib/recency";
import { Avatar } from "./components/Avatar";
import { AskInput } from "./components/AskInput";
import { AskThread } from "./components/AskThread";
import { HeadsCarousel } from "./components/HeadsCarousel";
import { ProjectView } from "./components/ProjectView";
import { shortRepoName } from "./lib/format";
import { UserCard } from "./components/UserCard";

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "ready"; me: Me; users: FeedUser[]; sessions: FeedSessionSnapshot[] }
  | { kind: "error"; message: string };

type View = { kind: "card" } | { kind: "thread" } | { kind: "project"; repoFullName: string };

const GERUND_INTERVAL_MS = 2200;

export default function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "card" });
  const [thread, setThread] = useState<{
    threadId: string | null;
    messages: ChatMessage[];
  }>({ threadId: null, messages: [] });
  const [askBusy, setAskBusy] = useState(false);
  const [gerundIdx, setGerundIdx] = useState(0);
  const [gerunds, setGerunds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    try {
      const [me, users, sessions] = await Promise.all([fetchMe(), fetchFeedUsers(), fetchFeed()]);
      setState({ kind: "ready", me, users, sessions });
      setSelectedLogin((cur) => cur ?? me.githubLogin);
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

  useWebSocket(state.kind === "ready", load);

  // Cycle gerunds while a chat call is in flight.
  useEffect(() => {
    if (!askBusy || gerunds.length === 0) return;
    const t = setInterval(() => setGerundIdx((i) => (i + 1) % gerunds.length), GERUND_INTERVAL_MS);
    return () => clearInterval(t);
  }, [askBusy, gerunds]);

  const heads = useMemo(() => {
    if (state.kind !== "ready") return [];
    return buildCarouselHeads(
      state.me.githubLogin,
      state.me.avatarUrl,
      state.users,
      state.sessions,
    );
  }, [state]);

  const visibleRepos = useMemo(() => {
    if (state.kind !== "ready") return [];
    const set = new Set<string>();
    for (const u of state.users) for (const r of u.repos) set.add(r);
    for (const s of state.sessions) if (s.repo_full_name) set.add(s.repo_full_name);
    return Array.from(set).sort();
  }, [state]);

  const handleSelect = (login: string) => {
    setSelectedLogin(login);
    setView({ kind: "card" });
  };

  const handleSearch = () => {
    if (state.kind !== "ready") return;
    const repo = pickProjectRepo(state.sessions, state.users, selectedLogin);
    if (repo) setView({ kind: "project", repoFullName: repo });
  };

  const handleAsk = useCallback(
    async (text: string) => {
      if (state.kind !== "ready") return;
      const userText =
        view.kind === "project"
          ? `(About the project ${view.repoFullName}) ${text}`
          : selectedLogin && selectedLogin !== state.me.githubLogin
            ? `(About @${selectedLogin}) ${text}`
            : text;

      const userMsg: ChatMessage = { role: "user", content: userText };
      const nextMessages: ChatMessage[] = [...thread.messages, userMsg];
      setThread({ threadId: thread.threadId, messages: nextMessages });
      setView({ kind: "thread" });
      setAskBusy(true);
      setGerundIdx(0);

      // Fire gerund prompt in parallel with the actual ask. If gerunds resolve
      // first we cycle through them as the loading hint; if ask wins, we just
      // never use them.
      void fetchGerunds(text)
        .then((g) => setGerunds(g.words.slice(0, 6)))
        .catch(() => {
          /* gerunds are best-effort */
        });

      try {
        const res = await askChat({
          messages: nextMessages,
          threadId: thread.threadId ?? undefined,
        });
        setThread({
          threadId: res.threadId,
          messages: [...nextMessages, res.message],
        });
      } catch (err) {
        if (err instanceof AuthError) {
          setState({ kind: "signed-out" });
          return;
        }
        const errMsg: ChatMessage = {
          role: "assistant",
          content: `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
        };
        setThread({ threadId: thread.threadId, messages: [...nextMessages, errMsg] });
      } finally {
        setAskBusy(false);
        setGerunds([]);
      }
    },
    [selectedLogin, state, thread, view],
  );

  if (state.kind === "loading") {
    return <CenterShell title="Slashtalk" detail="Loading team presence…" />;
  }
  if (state.kind === "signed-out") {
    return (
      <CenterShell title="Slashtalk" detail="Sign in to see your team's live sessions.">
        <button
          className="rounded-full bg-primary px-5 py-2.5 font-semibold text-primary-fg hover:bg-primary-hover"
          onClick={signIn}
        >
          Sign in with GitHub
        </button>
      </CenterShell>
    );
  }
  if (state.kind === "error") {
    return (
      <CenterShell title="Slashtalk" detail={state.message}>
        <button
          className="rounded-full border border-divider bg-surface px-5 py-2.5 font-semibold text-fg hover:bg-surface-alt"
          onClick={() => void load()}
        >
          Retry
        </button>
      </CenterShell>
    );
  }

  const selectedHead = heads.find((h) => h.login === selectedLogin) ?? heads[0];
  const contextHint =
    view.kind === "project"
      ? shortRepoName(view.repoFullName)
      : selectedHead && selectedHead.login !== state.me.githubLogin
        ? `@${selectedHead.login}`
        : null;
  const busyHint = askBusy && gerunds.length > 0 ? gerunds[gerundIdx] : null;

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-2xl flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-divider bg-surface px-3 py-2.5">
        <div className="flex items-center gap-2">
          <img src="/app/icons/icon.svg" alt="" className="h-7 w-7 rounded-md" />
          <h1 className="m-0 text-md font-semibold text-fg">Slashtalk</h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-subtle">
          <Avatar src={state.me.avatarUrl} login={state.me.githubLogin} size={28} />
          <span className="hidden sm:inline">@{state.me.githubLogin}</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {view.kind === "thread" ? (
          <AskThread
            messages={thread.messages}
            busy={askBusy}
            busyHint={busyHint}
            onBack={() => setView({ kind: "card" })}
          />
        ) : view.kind === "project" ? (
          <ProjectView
            repoFullName={view.repoFullName}
            visibleRepos={visibleRepos}
            onPickRepo={(r) => setView({ kind: "project", repoFullName: r })}
            onPickPerson={handleSelect}
            onAuthError={() => setState({ kind: "signed-out" })}
          />
        ) : selectedHead ? (
          <div className="px-3 py-3">
            <UserCard
              login={selectedHead.login}
              avatarUrl={selectedHead.avatarUrl}
              isSelf={selectedHead.isSelf}
              sessions={state.sessions}
              onAuthError={() => setState({ kind: "signed-out" })}
            />
          </div>
        ) : (
          <div className="px-3 py-6 text-center text-sm text-subtle">No teammates visible yet.</div>
        )}
      </main>

      <HeadsCarousel
        heads={heads}
        selectedLogin={selectedHead?.login ?? null}
        onSelect={handleSelect}
        onSearch={handleSearch}
      />

      <AskInput
        onSubmit={(text) => void handleAsk(text)}
        busy={askBusy}
        busyHint={busyHint}
        contextHint={contextHint}
      />
    </div>
  );
}

function CenterShell({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <main className="flex h-[100dvh] flex-col items-center justify-center gap-3.5 px-6 text-center">
      <img src="/app/icons/icon.svg" alt="" className="h-14 w-14 rounded-2xl" />
      <h1 className="m-0 text-2xl text-fg">{title}</h1>
      <p className="m-0 max-w-md text-sm leading-relaxed text-muted">{detail}</p>
      {children ? <div className="mt-2">{children}</div> : null}
    </main>
  );
}

function signIn(): void {
  window.location.assign(`/auth/github?return_to=${encodeURIComponent("/app/")}`);
}

/** Pick the repo for the project view when search is tapped. Prefers the
 *  selected user's current session repo; falls back to the first repo we
 *  know the viewer can see. Returns null if no repos are visible at all. */
function pickProjectRepo(
  sessions: FeedSessionSnapshot[],
  users: FeedUser[],
  selectedLogin: string | null,
): string | null {
  if (selectedLogin) {
    const userSessions = sessions
      .filter((s) => s.github_login === selectedLogin && s.repo_full_name)
      .sort((a, b) => new Date(b.lastTs ?? 0).getTime() - new Date(a.lastTs ?? 0).getTime());
    if (userSessions[0]?.repo_full_name) return userSessions[0].repo_full_name;
  }
  for (const u of users) {
    if (u.repos[0]) return u.repos[0];
  }
  return null;
}

function useWebSocket(active: boolean, onMessage: () => void): void {
  // Reconnect with capped exponential backoff. Replaces the old single-shot
  // socket that went silent on the first network blip.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!active) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      const url = new URL("/ws", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        retry = 0;
      });
      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { type?: string };
          if (
            msg.type === "session_updated" ||
            msg.type === "session_insights_updated" ||
            msg.type === "collision_detected" ||
            msg.type === "pr_activity"
          ) {
            onMessageRef.current();
          }
        } catch {
          /* ignore malformed */
        }
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        const delay = Math.min(30_000, 1000 * 2 ** retry);
        retry += 1;
        timer = setTimeout(open, delay);
      });
    };

    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close(1000, "app unmounted");
    };
  }, [active]);
}
