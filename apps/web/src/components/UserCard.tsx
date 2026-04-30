import { useEffect, useState } from "react";
import { BoltIcon, ChevronRightIcon, ClockIcon } from "@heroicons/react/24/outline";
import {
  SessionState,
  type FeedSessionSnapshot,
  type StandupResponse,
  type UserPr,
  type UserPrsResponse,
} from "@slashtalk/shared";
import { AuthError, fetchUserPrs, fetchUserStandup } from "../lib/api";
import { fmtDuration, fmtTokens, repoName, timeAgo } from "../lib/format";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { PrRow } from "./PrRow";

const NOW_WINDOW_MS = 2 * 60 * 60 * 1000;

interface UserCardProps {
  login: string;
  avatarUrl: string | null;
  isSelf: boolean;
  sessions: FeedSessionSnapshot[];
  onAuthError: () => void;
}

type DashboardState =
  | { kind: "loading" }
  | { kind: "ready"; standup: string | null; prs: UserPr[]; noClaimedRepos: boolean }
  | { kind: "error"; message: string };

export function UserCard({
  login,
  avatarUrl,
  isSelf,
  sessions,
  onAuthError,
}: UserCardProps): JSX.Element {
  const [dashboard, setDashboard] = useState<DashboardState>({ kind: "loading" });
  const userSessions = sessions.filter((s) => s.github_login === login);
  const nowSession = pickNowSession(userSessions);

  useEffect(() => {
    let cancelled = false;
    setDashboard((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    Promise.all([fetchUserPrs(login), fetchUserStandup(login)])
      .then(([prsRes, standupRes]: [UserPrsResponse, StandupResponse]) => {
        if (cancelled) return;
        setDashboard({
          kind: "ready",
          standup: standupRes.summary,
          prs: prsRes.prs,
          noClaimedRepos: standupRes.noClaimedRepos === true || prsRes.noClaimedRepos === true,
        });
      })
      .catch((err) => {
        if (err instanceof AuthError) {
          if (!cancelled) onAuthError();
          return;
        }
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
    // Standup + PRs are computed server-side from cached state and only meaningfully
    // change when the selected user changes. WS-driven session updates flow through
    // the `sessions` prop separately to keep the NOW section live without re-fetching.
  }, [login, onAuthError]);

  const aggregateTokens = fmtTokens(sumTokens(userSessions));

  return (
    <article className="rounded-xl border border-divider bg-surface text-fg shadow-card overflow-hidden">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3">
        <Avatar src={avatarUrl} login={login} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-md font-semibold">
            @{login}
            {isSelf ? <span className="ml-2 text-xs font-normal text-subtle">you</span> : null}
          </h2>
          <p className="m-0 mt-1 text-xs text-subtle">
            {nowSession?.state === SessionState.BUSY || nowSession?.state === SessionState.ACTIVE
              ? "Working now"
              : `Last active ${timeAgo(userSessions[0]?.lastTs)}`}
            {aggregateTokens ? ` · ${aggregateTokens} tokens` : ""}
          </p>
        </div>
      </header>

      {dashboard.kind === "ready" && dashboard.noClaimedRepos ? (
        <NoRepoSection isSelf={isSelf} />
      ) : (
        <>
          <Divider />
          {nowSession ? (
            <>
              <NowSection session={nowSession} />
              <Divider />
            </>
          ) : null}
          <TodaySection dashboard={dashboard} />
          <Divider />
          <PrsSection dashboard={dashboard} />
        </>
      )}
    </article>
  );
}

function NowSection({ session }: { session: FeedSessionSnapshot }): JSX.Element {
  const status = sessionStatus(session);
  const tokens = fmtTokens(session.tokens);
  return (
    <section className="px-4 py-3">
      <SectionLabel icon={<BoltIcon className="h-3.5 w-3.5" />} label="Now" />
      <a className="block text-fg no-underline" href={`/app/sessions/${session.id}`}>
        <p className="m-0 text-md leading-snug">
          {session.description ? (
            session.description
          ) : (
            <span className="text-subtle">Summarizing current session…</span>
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-xs font-semibold text-subtle">
          <span>{repoName(session.repo_full_name)}</span>
          {tokens ? <span>{tokens} tokens</span> : null}
          {status ? (
            <span className={status.isLive ? "text-success" : undefined}>{status.text}</span>
          ) : null}
        </div>
      </a>
    </section>
  );
}

function TodaySection({ dashboard }: { dashboard: DashboardState }): JSX.Element {
  return (
    <section className="px-4 py-3">
      <SectionLabel icon={<ClockIcon className="h-3.5 w-3.5" />} label="Today" />
      {dashboard.kind === "loading" ? (
        <p className="m-0 text-sm text-subtle">Fetching…</p>
      ) : dashboard.kind === "error" ? (
        <p className="m-0 text-sm text-subtle">Could not load today.</p>
      ) : dashboard.standup ? (
        <Markdown>{dashboard.standup}</Markdown>
      ) : (
        <p className="m-0 text-sm text-subtle">Nothing shipped yet today.</p>
      )}
    </section>
  );
}

function PrsSection({ dashboard }: { dashboard: DashboardState }): JSX.Element {
  const [open, setOpen] = useState(false);
  const prs = dashboard.kind === "ready" ? dashboard.prs : null;
  const count = prs?.length ?? 0;

  return (
    <section className="px-4 pb-4 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-surface-alt/40"
      >
        <ChevronRightIcon
          className={`h-3.5 w-3.5 text-subtle transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-xs font-bold uppercase tracking-wide text-subtle">PRs pushed</span>
        {count > 0 ? (
          <span className="ml-1 rounded-full bg-surface-alt px-1.5 text-xs font-semibold text-fg">
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        dashboard.kind === "loading" ? (
          <p className="mt-2 text-sm text-subtle">Loading…</p>
        ) : dashboard.kind === "error" ? (
          <p className="mt-2 text-sm text-subtle">Could not load PRs.</p>
        ) : prs && prs.length > 0 ? (
          <div className="mt-2">
            {prs.slice(0, 8).map((pr) => (
              <PrRow key={`${pr.repoFullName}#${pr.number}`} pr={pr} />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-subtle">No PRs in this window.</p>
        )
      ) : null}
    </section>
  );
}

function NoRepoSection({ isSelf }: { isSelf: boolean }): JSX.Element {
  return (
    <div className="px-4 pb-4 pt-3">
      <p className="m-0 text-sm text-fg">No repos connected yet.</p>
      <p className="m-0 mt-1 text-xs text-subtle">
        {isSelf
          ? "Claim a repo from the desktop app to see your standup and PRs here."
          : "This teammate hasn't claimed a repo yet."}
      </p>
    </div>
  );
}

function SectionLabel({ icon, label }: { icon: JSX.Element; label: string }): JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-subtle">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function Divider(): JSX.Element {
  return <div className="mx-4 h-px bg-divider" />;
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

function sumTokens(sessions: FeedSessionSnapshot[]) {
  const total = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const s of sessions) {
    total.in += s.tokens.in;
    total.out += s.tokens.out;
    total.cacheRead += s.tokens.cacheRead;
    total.cacheWrite += s.tokens.cacheWrite;
    total.reasoning += s.tokens.reasoning;
  }
  return total;
}
