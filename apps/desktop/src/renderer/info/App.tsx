import { Fragment, useEffect, useRef, useState } from "react";
import { SessionState } from "@slashtalk/shared";
import type { RecentEvent, TokenUsage } from "@slashtalk/shared";
import type { ChatHead, InfoSession } from "../../shared/types";
import { AgentPanel } from "./AgentPanel";
import { useAutoResize } from "../shared/useAutoResize";
import { useLocationWeather } from "../shared/useLocationWeather";

const REFRESH_MS = 15_000;

const DOT_COLOR: Record<SessionState, string> = {
  [SessionState.BUSY]: "bg-success",
  [SessionState.ACTIVE]: "bg-success",
  [SessionState.IDLE]: "bg-warning",
  [SessionState.RECENT]: "bg-muted",
  [SessionState.ENDED]: "bg-muted",
};

export function App(): JSX.Element {
  const [head, setHead] = useState<ChatHead | null>(null);
  const [sessions, setSessions] = useState<InfoSession[] | null>(null);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Measure the inner content, not the card: the card is capped at max-h-screen
  // so its height saturates at the window size and wouldn't signal growth.
  useAutoResize(contentRef);

  useEffect(() => {
    const offShow = window.chatheads.onInfoShow((p) => {
      setHead(p.head);
      setSessions(p.sessions);
      setVisible(true);
    });
    // Keep head/sessions on hide so the last content fades out instead of
    // collapsing; next show replaces them wholesale.
    const offHide = window.chatheads.onInfoHide(() => setVisible(false));
    return () => {
      offShow();
      offHide();
    };
  }, []);

  useEffect(() => {
    if (!head) return;
    if (head.kind === "agent") {
      setSessions([]);
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const rows = await window.chatheads.listSessionsForHead(head.id);
        if (!cancelled) setSessions(rows);
      } catch {
        if (!cancelled) setSessions([]);
      }
    };
    // Main sends the cached payload (possibly null on cache miss). Load once
    // immediately if sessions aren't in hand yet, and poll on interval after.
    if (sessions === null) void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // sessions intentionally not a dep — we only want this to (re)run when
    // the head changes; interval handles subsequent refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        void window.chatheads.hideInfo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => void window.chatheads.infoHoverEnter()}
      onMouseLeave={() => void window.chatheads.infoHoverLeave()}
      className="bg-card rounded-3xl max-h-screen overflow-y-auto transition-[opacity,transform] duration-75 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateX(0)" : "translateX(-4px)",
      }}
    >
      <div ref={contentRef}>
        {head?.kind === "agent" ? (
          <AgentPanel head={head} />
        ) : head?.kind === "repo" ? (
          <>
            <Header head={head} />
            <Divider />
            <RepoSessionsSection sessions={sessions} />
          </>
        ) : (
          <>
            <Header head={head} />
            <Divider />
            <SessionsSection sessions={sessions} />
          </>
        )}
      </div>
    </div>
  );
}

function Divider(): JSX.Element {
  return <div className="mx-lg h-px bg-divider" />;
}

function Header({ head }: { head: ChatHead | null }): JSX.Element {
  if (head?.kind === "repo") return <RepoHeader head={head} />;
  return <UserHeader head={head} />;
}

function UserHeader({ head }: { head: ChatHead | null }): JSX.Element {
  const name = head?.label ?? "—";
  const time = new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const { city, icon } = useLocationWeather();
  return (
    <div className="flex items-start gap-md px-lg pt-lg pb-md">
      <Avatar head={head} />
      <div className="flex-1 min-w-0">
        <div className="text-[19px] font-bold leading-tight truncate">
          {name}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted whitespace-nowrap min-w-0">
          {city && (
            <>
              {icon && <span className="shrink-0">{icon}</span>}
              <span className="truncate">{city}</span>
              <span className="text-subtle shrink-0">·</span>
            </>
          )}
          <span className="shrink-0">{time}</span>
        </div>
      </div>
      <button
        onClick={() => window.chatheads.hideInfo()}
        className="w-6 h-6 rounded-full bg-surface flex items-center justify-center text-muted text-[11px] leading-none shrink-0 hover:opacity-60 transition-opacity cursor-pointer"
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}

function RepoHeader({ head }: { head: ChatHead }): JSX.Element {
  const full = head.repoFullName ?? head.label;
  const slash = full.lastIndexOf("/");
  const owner = slash >= 0 ? full.slice(0, slash) : "";
  const name = slash >= 0 ? full.slice(slash + 1) : full;
  return (
    <div className="flex items-start gap-md px-lg pt-lg pb-md">
      <Avatar head={head} />
      <div className="flex-1 min-w-0">
        <div className="text-[19px] font-bold leading-tight truncate">
          {name}
        </div>
        {owner && (
          <div className="mt-1 text-[12px] text-muted truncate">{owner}</div>
        )}
      </div>
      <button
        onClick={() => window.chatheads.hideInfo()}
        className="w-6 h-6 rounded-full bg-surface flex items-center justify-center text-muted text-[11px] leading-none shrink-0 hover:opacity-60 transition-opacity cursor-pointer"
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}

function Avatar({ head }: { head: ChatHead | null }): JSX.Element {
  if (head?.avatar.type === "remote") {
    return (
      <img
        src={head.avatar.value}
        alt=""
        className="w-12 h-12 rounded-full object-cover shrink-0"
      />
    );
  }
  const emoji = head?.avatar.type === "emoji" ? head.avatar.value : "👤";
  const tint = head?.tint ?? "var(--color-surface)";
  return (
    <div className="relative w-12 h-12 rounded-full flex items-center justify-center text-[26px] shrink-0 overflow-hidden">
      <div
        className="absolute inset-0 rounded-full opacity-30"
        style={{ background: tint }}
      />
      <span className="relative leading-none">{emoji}</span>
    </div>
  );
}

function SubHeader({ children }: { children: string }): JSX.Element {
  return (
    <div className="text-[11px] font-semibold tracking-wider uppercase text-subtle">
      {children}
    </div>
  );
}

const DEFAULT_SESSION_LIMIT = 5;

function SessionsSection({
  sessions,
}: {
  sessions: InfoSession[] | null;
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (sessions == null) {
    return (
      <div className="px-lg py-md text-[12px] text-subtle min-h-[60px]">
        Loading…
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div className="px-lg py-md text-[12px] text-subtle min-h-[60px]">
        No sessions yet.
      </div>
    );
  }
  const visible =
    showAll || sessions.length <= DEFAULT_SESSION_LIMIT
      ? sessions
      : sessions.slice(0, DEFAULT_SESSION_LIMIT);
  const hasMore = sessions.length > DEFAULT_SESSION_LIMIT;
  return (
    <div>
      <SessionList
        sessions={visible}
        expandedId={expandedId}
        onToggle={(id) =>
          setExpandedId((cur) => (cur === id ? null : id))
        }
      />
      {hasMore && (
        <>
          <div className="mx-lg h-px bg-divider" />
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="w-full px-lg py-md text-center text-[12px] font-medium text-muted hover:text-fg hover:bg-surface/60 transition-colors cursor-pointer"
          >
            {showAll ? "Show less" : `Show all (${sessions.length})`}
          </button>
        </>
      )}
    </div>
  );
}

// "Current" = live or paused sessions (heartbeat still alive).
// "Completed" = server-classified RECENT/ENDED.
const ACTIVE_STATES = new Set<SessionState>([
  SessionState.BUSY,
  SessionState.ACTIVE,
  SessionState.IDLE,
]);

function tsOf(s: InfoSession): number {
  return s.lastTs ? new Date(s.lastTs).getTime() : 0;
}

function RepoSessionsSection({
  sessions,
}: {
  sessions: InfoSession[] | null;
}): JSX.Element {
  // Expansion state is shared across the two groups so expanding one session
  // collapses a previously-expanded one regardless of which group it's in.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (sessions == null) {
    return (
      <div className="px-lg py-md text-[12px] text-subtle min-h-[60px]">
        Loading…
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div className="px-lg py-md text-[12px] text-subtle min-h-[60px]">
        No sessions yet.
      </div>
    );
  }

  // Sort by lastTs desc within each group — most recent activity on top.
  const active = sessions
    .filter((s) => ACTIVE_STATES.has(s.state))
    .sort((a, b) => tsOf(b) - tsOf(a));
  const completed = sessions
    .filter((s) => !ACTIVE_STATES.has(s.state))
    .sort((a, b) => tsOf(b) - tsOf(a));

  const onToggle = (id: string): void =>
    setExpandedId((cur) => (cur === id ? null : id));

  return (
    <div>
      {active.length > 0 && (
        <>
          <div className="px-lg pt-md pb-1">
            <SubHeader>Active</SubHeader>
          </div>
          <SessionList
            sessions={active}
            expandedId={expandedId}
            onToggle={onToggle}
            showPerson
          />
        </>
      )}
      {active.length > 0 && completed.length > 0 && (
        <div className="mx-lg my-md h-px bg-divider" />
      )}
      {completed.length > 0 && (
        <>
          <div className="px-lg pt-md pb-1">
            <SubHeader>Completed</SubHeader>
          </div>
          <SessionList
            sessions={completed}
            expandedId={expandedId}
            onToggle={onToggle}
            showPerson
          />
        </>
      )}
    </div>
  );
}

function SessionList({
  sessions,
  expandedId,
  onToggle,
  showPerson = false,
}: {
  sessions: InfoSession[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  showPerson?: boolean;
}): JSX.Element {
  return (
    <>
      {sessions.map((s, i) => (
        <Fragment key={s.id}>
          {i > 0 && <div className="mx-lg h-px bg-divider" />}
          <SessionRow
            session={s}
            expanded={expandedId === s.id}
            onToggle={() => onToggle(s.id)}
            showPerson={showPerson}
          />
        </Fragment>
      ))}
    </>
  );
}

function repoLabel(s: InfoSession): string | null {
  if ("repo_full_name" in s && s.repo_full_name) {
    const slash = s.repo_full_name.lastIndexOf("/");
    return slash >= 0 ? s.repo_full_name.slice(slash + 1) : s.repo_full_name;
  }
  // Fallback for own sessions: both uploaders store `project` as a slugified
  // cwd path, so the trailing segment is usually the repo dir.
  const parts = s.project.split(/[-/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

function SessionRow({
  session,
  expanded,
  onToggle,
  showPerson = false,
}: {
  session: InfoSession;
  expanded: boolean;
  onToggle: () => void;
  showPerson?: boolean;
}): JSX.Element {
  const repo = repoLabel(session);
  const title = session.title ?? session.lastUserPrompt ?? "Untitled session";
  const tokenStr = fmtTokens(session.tokens);
  const showDot =
    session.state === SessionState.ACTIVE ||
    session.state === SessionState.BUSY;
  const shrinkableParts = [repo, session.branch].filter(
    (v): v is string => Boolean(v),
  );
  const tokensLabel = tokenStr ? `${tokenStr} tokens` : null;
  const hasMeta = shrinkableParts.length > 0 || tokensLabel !== null;
  // FeedSessionSnapshot carries the owner's github_login + avatar_url. Own
  // sessions (SessionSnapshot) don't, so the byline silently no-ops for them.
  const personLogin =
    showPerson && "github_login" in session ? session.github_login : null;
  const personAvatar =
    showPerson && "avatar_url" in session ? session.avatar_url : null;

  return (
    <div className={expanded ? "bg-surface" : undefined}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-lg py-md cursor-pointer hover:bg-surface/60 transition-colors flex items-center gap-2"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {showDot && <Dot color={DOT_COLOR[session.state]} />}
            <div className="text-[14px] font-medium text-fg flex-1 truncate">
              {title}
            </div>
          </div>
          {personLogin && (
            <div
              className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted min-w-0"
              style={showDot ? { marginLeft: 14 } : undefined}
            >
              {personAvatar ? (
                <img
                  src={personAvatar}
                  alt=""
                  className="w-3.5 h-3.5 rounded-full object-cover shrink-0"
                />
              ) : (
                <span className="w-3.5 h-3.5 rounded-full bg-surface shrink-0" />
              )}
              <span className="truncate font-medium text-fg/80">
                {personLogin}
              </span>
            </div>
          )}
          {session.description && (
            <div
              className="mt-1 text-[12px] text-muted line-clamp-2"
              style={showDot ? { marginLeft: 14 } : undefined}
            >
              {session.description}
            </div>
          )}
          {hasMeta && (
            <div
              className="mt-px flex items-center gap-1.5 text-[11.5px] text-muted min-w-0"
              style={showDot ? { marginLeft: 14 } : undefined}
            >
              {shrinkableParts.map((v, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="text-subtle shrink-0">·</span>}
                  <span className="truncate min-w-0">{v}</span>
                </Fragment>
              ))}
              {tokensLabel && (
                <>
                  {shrinkableParts.length > 0 && (
                    <span className="text-subtle shrink-0">·</span>
                  )}
                  <span className="shrink-0">{tokensLabel}</span>
                </>
              )}
            </div>
          )}
        </div>
        <Chevron open={expanded} />
      </button>
      {expanded && <ExpandedSession session={session} />}
    </div>
  );
}

function ExpandedSession({ session }: { session: InfoSession }): JSX.Element {
  // Prefer the LLM rolling narrative; fall back to the raw user prompt only
  // if it adds info beyond the title.
  const summary =
    session.rollingSummary ??
    (session.lastUserPrompt && session.lastUserPrompt !== session.title
      ? session.lastUserPrompt
      : null);
  // Defensive: the server sometimes returns non-array shapes here (stale rows
  // where the rolling-summary analyzer output didn't match its JSON schema).
  // Without this, .map crashes the whole tree and the card goes blank.
  const highlights = Array.isArray(session.highlights) ? session.highlights : [];
  const recent = Array.isArray(session.recent) ? session.recent : [];
  const hasAnything =
    Boolean(summary) || highlights.length > 0 || recent.length > 0;
  return (
    <div className="px-lg pb-lg space-y-md">
      {summary && (
        <div>
          <SubHeader>Summary</SubHeader>
          <div className="mt-1 text-[13px] text-fg leading-relaxed whitespace-pre-wrap">
            {summary}
          </div>
        </div>
      )}
      {highlights.length > 0 && (
        <div>
          <SubHeader>Highlights</SubHeader>
          <ul className="mt-1 text-[12.5px] text-fg/90 space-y-0.5 list-disc list-inside">
            {highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      {recent.length > 0 && (
        <div>
          <SubHeader>Latest activity</SubHeader>
          <div className="mt-1 space-y-md">
            {recent.slice(0, 4).map((e, i) => (
              <ActivityRow key={i} event={e} />
            ))}
          </div>
        </div>
      )}
      {!hasAnything && (
        <div className="text-[12px] text-subtle">No activity yet.</div>
      )}
    </div>
  );
}

function ActivityRow({ event }: { event: RecentEvent }): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <ArrowIcon />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-fg leading-snug break-words">
          {event.summary}
        </div>
        <div className="mt-0.5 text-[11.5px] text-subtle">
          {fmtAgo(event.ts)}
        </div>
      </div>
    </div>
  );
}

function fmtTokens(tokens: TokenUsage | undefined): string | null {
  if (!tokens) return null;
  const total =
    tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
  if (total <= 0) return null;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${total}`;
}

function fmtAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 30) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  const roundedH = rem >= 30 ? h + 1 : h;
  if (roundedH < 24) return `${roundedH}h ago`;
  const d = Math.floor(roundedH / 24);
  return `${d}d ago`;
}

function Dot({ color }: { color: string }): JSX.Element {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color}`} />;
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className="text-subtle shrink-0 transition-transform duration-150"
      style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
      aria-hidden
    >
      <path
        d="M3.5 5.25 L7 8.75 L10.5 5.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className="text-subtle shrink-0 mt-0.5"
      aria-hidden
    >
      <path
        d="M3 7 L11 7 M8 4 L11 7 L8 10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
