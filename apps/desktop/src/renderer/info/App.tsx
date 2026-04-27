import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { SessionState } from "@slashtalk/shared";
import type { EventSource, RecentEvent, SpotifyPresence, TokenUsage } from "@slashtalk/shared";
import type { ChatHead, InfoSession } from "../../shared/types";
import { AgentPanel } from "./AgentPanel";
import { useAutoResize } from "../shared/useAutoResize";
import { useLocationWeather } from "../shared/useLocationWeather";
import { Markdown } from "../shared/Markdown";
import { BranchIcon, ClaudeIcon, OpenAIIcon } from "../shared/icons";

const REFRESH_MS = 15_000;

export function App(): JSX.Element {
  const [head, setHead] = useState<ChatHead | null>(null);
  const [sessions, setSessions] = useState<InfoSession[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [expandRequest, setExpandRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  const [spotify, setSpotify] = useState<SpotifyPresence | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Measure the inner content, not the card: the card is capped at max-h-screen
  // so its height saturates at the window size and wouldn't signal growth.
  useAutoResize(contentRef);

  useEffect(() => {
    const offShow = window.chatheads.onInfoShow((p) => {
      setHead(p.head);
      setSessions(p.sessions);
      setSpotify(p.spotify);
      setVisible(true);
      // Re-request even when id matches a prior request — clicking the same
      // card twice should re-expand if the user collapsed it in between.
      if (p.expandSessionId) {
        setExpandRequest((cur) => ({
          id: p.expandSessionId!,
          nonce: (cur?.nonce ?? 0) + 1,
        }));
      }
    });
    // Keep head/sessions/spotify on hide so the last content fades out instead
    // of collapsing; next show replaces them wholesale.
    const offHide = window.chatheads.onInfoHide(() => setVisible(false));
    const offPresence = window.chatheads.onInfoPresence((p) => {
      // Main already filtered to the visible head, but double-check in case
      // a hide → show raced between the two events.
      setHead((h) => {
        if (h && h.label === p.login) setSpotify(p.spotify);
        return h;
      });
    });
    // Mirror rail-level head updates onto the visible head so transient
    // fields (collisionAt/File, prActivityAt, lastActionAt, live) stay in
    // sync. Without this the popover holds the snapshot taken at open time
    // and dismiss/refresh actions don't propagate until the next show.
    const offUpdate = window.chatheads.onUpdate((heads) => {
      setHead((cur) => {
        if (!cur) return cur;
        const next = heads.find((h) => h.id === cur.id);
        return next ?? cur;
      });
    });
    return () => {
      offShow();
      offHide();
      offPresence();
      offUpdate();
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
        const [rows, sp] = await Promise.all([
          window.chatheads.listSessionsForHead(head.id),
          window.chatheads.getSpotifyForLogin(head.label),
        ]);
        if (cancelled) return;
        setSessions(rows);
        setSpotify(sp);
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
  }, [head?.id, head?.label]);

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
      className="bg-card rounded-3xl h-screen overflow-y-auto transition-[opacity,transform] duration-75 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateX(0)" : "translateX(-4px)",
      }}
    >
      <div ref={contentRef}>
        {head?.kind === "agent" ? (
          <AgentPanel head={head} />
        ) : (
          <>
            <UserHeader head={head} />
            {spotify && <NowPlaying track={spotify} />}
            <Divider />
            <SessionsSection
              sessions={sessions}
              expandRequest={expandRequest}
              collisionFile={head?.collisionAt != null ? (head.collisionFile ?? null) : null}
              collisionLogin={head?.label ?? null}
            />
          </>
        )}
      </div>
    </div>
  );
}

function NowPlaying({ track }: { track: SpotifyPresence }): JSX.Element {
  const open = (): void => {
    void window.chatheads.openExternal(track.url);
  };
  return (
    <button
      onClick={open}
      title={`Open on Spotify: ${track.name} — ${track.artist}`}
      className="w-full text-left px-lg pb-md flex items-center gap-2 min-w-0 group cursor-pointer"
    >
      <SpotifyIcon />
      <div className="flex-1 min-w-0 text-[12.5px] leading-tight truncate">
        <span className="text-fg font-medium">{track.name}</span>
        <span className="text-subtle"> — </span>
        <span className="text-muted">{track.artist}</span>
      </div>
      <span className="text-subtle text-[11px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        open ↗
      </span>
    </button>
  );
}

function SpotifyIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954" className="shrink-0" aria-hidden>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.586 14.424a.623.623 0 0 1-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 1 1-.277-1.215c3.809-.871 7.077-.496 9.713 1.115a.623.623 0 0 1 .206.857zm1.223-2.723a.78.78 0 0 1-1.072.257c-2.687-1.652-6.785-2.131-9.965-1.166a.78.78 0 1 1-.45-1.494c3.633-1.102 8.147-.568 11.232 1.328a.78.78 0 0 1 .255 1.075zm.105-2.835C14.692 8.95 9.375 8.775 6.297 9.71a.935.935 0 1 1-.542-1.79c3.532-1.072 9.404-.865 13.115 1.338a.935.935 0 0 1-.956 1.608z" />
    </svg>
  );
}

function Divider(): JSX.Element {
  return <div className="mx-lg h-px bg-divider" />;
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
        <div className="text-[19px] font-bold leading-tight truncate">{name}</div>
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
      <div className="absolute inset-0 rounded-full opacity-30" style={{ background: tint }} />
      <span className="relative leading-none">{emoji}</span>
    </div>
  );
}

function SubHeader({ children }: { children: string }): JSX.Element {
  return (
    <div className="text-[11px] font-semibold tracking-wider uppercase text-subtle">{children}</div>
  );
}

const DEFAULT_SESSION_LIMIT = 5;

function SessionsSection({
  sessions,
  expandRequest,
  collisionFile,
  collisionLogin,
}: {
  sessions: InfoSession[] | null;
  expandRequest: { id: string; nonce: number } | null;
  collisionFile: string | null;
  collisionLogin: string | null;
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Honor external expand requests (e.g. from a chat-card click). Reveal the
  // session if it's below the default limit, then expand it.
  useEffect(() => {
    if (!expandRequest || !sessions) return;
    const idx = sessions.findIndex((s) => s.id === expandRequest.id);
    if (idx < 0) return;
    if (idx >= DEFAULT_SESSION_LIMIT) setShowAll(true);
    setExpandedId(expandRequest.id);
  }, [expandRequest, sessions]);

  if (sessions == null) {
    return <div className="px-lg py-md text-[12px] text-subtle min-h-[60px]">Loading…</div>;
  }
  if (sessions.length === 0) {
    return <div className="px-lg py-md text-[12px] text-subtle min-h-[60px]">No sessions yet.</div>;
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
        onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
        collisionFile={collisionFile}
        collisionLogin={collisionLogin}
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

function SessionList({
  sessions,
  expandedId,
  onToggle,
  collisionFile,
  collisionLogin,
}: {
  sessions: InfoSession[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  collisionFile: string | null;
  collisionLogin: string | null;
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
            collisionFile={collisionFile}
            collisionLogin={collisionLogin}
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

function sessionTouchesFile(session: InfoSession, filePath: string): boolean {
  const sets = [session.topFilesEdited, session.topFilesWritten];
  for (const set of sets) {
    if (!Array.isArray(set)) continue;
    for (const entry of set) {
      if (Array.isArray(entry) && entry[0] === filePath) return true;
    }
  }
  return false;
}

/**
 * Trim an absolute file path to start at the repo root, e.g.
 * `/Users/erik/code/slashtalk/apps/server/src/x.ts` →
 * `/slashtalk/apps/server/src/x.ts`. Everything before the repo dir is
 * developer-machine-specific and irrelevant to readers.
 *
 * Resolution order:
 *   1. Strip session.cwd as a prefix (most precise — that's literally the
 *      repo root on the *other* machine).
 *   2. Otherwise, look up the repo basename from `repo_full_name`/`cwd`
 *      and slice from its last occurrence in the path.
 */
function repoBasenameFor(session: InfoSession): string | null {
  if ("repo_full_name" in session && session.repo_full_name) {
    const slash = session.repo_full_name.lastIndexOf("/");
    return slash >= 0 ? session.repo_full_name.slice(slash + 1) : session.repo_full_name;
  }
  if (session.cwd) {
    const parts = session.cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
  }
  return null;
}

function trimToRepoPath(filePath: string, session: InfoSession): string {
  const norm = filePath.replace(/\\/g, "/");

  if (session.cwd) {
    const cwd = session.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm.startsWith(cwd + "/")) {
      const repoBasename = repoBasenameFor(session);
      const tail = norm.slice(cwd.length); // starts with "/"
      return repoBasename ? `/${repoBasename}${tail}` : tail;
    }
  }

  const repoBasename = repoBasenameFor(session);
  if (repoBasename) {
    const needle = `/${repoBasename}/`;
    const idx = norm.lastIndexOf(needle);
    if (idx >= 0) return norm.slice(idx);
  }
  return norm;
}

function SessionRow({
  session,
  expanded,
  onToggle,
  collisionFile,
  collisionLogin,
}: {
  session: InfoSession;
  expanded: boolean;
  onToggle: () => void;
  collisionFile: string | null;
  collisionLogin: string | null;
}): JSX.Element {
  const repo = repoLabel(session);
  const title = session.title ?? session.lastUserPrompt ?? "Untitled session";
  const tokenStr = fmtTokens(session.tokens);
  const tokensLabel = tokenStr ? `${tokenStr} tokens` : null;
  const status = statusLabel(session);
  const hasLocator = Boolean(repo) || Boolean(session.branch);
  // Only flag collisions on sessions that aren't already wrapped — an ENDED
  // session touching the same file is just historical, not a real conflict.
  const sessionLive = session.state !== SessionState.ENDED;
  const colliding =
    collisionFile != null && sessionLive && sessionTouchesFile(session, collisionFile);

  // Border priority: collision (outranks expanded) > expanded > none.
  const borderClass = colliding
    ? "border-danger"
    : expanded
      ? "border-success/70"
      : "border-transparent";

  return (
    <div className={expanded ? "bg-surface" : undefined}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`w-full text-left px-lg py-md cursor-pointer hover:bg-surface/60 transition-colors flex items-start gap-2 border-l-2 ${borderClass}`}
      >
        <div className="flex-1 min-w-0">
          {/* Full title, no truncation — long titles wrap. */}
          <div className="text-[14px] font-medium text-fg break-words">{title}</div>
          {hasLocator && (
            <div className="mt-1 flex min-w-0">
              <span className="inline-flex items-center gap-1 font-mono text-[10.5px] leading-none px-1.5 py-0.5 rounded bg-surface/70 text-fg/75 min-w-0 max-w-full">
                {repo && <span className="truncate">{repo}</span>}
                {repo && session.branch && <span className="text-subtle shrink-0 px-0.5">·</span>}
                {session.branch && (
                  <>
                    <span className="text-subtle shrink-0">
                      <BranchIcon />
                    </span>
                    <span className="truncate">{session.branch}</span>
                  </>
                )}
              </span>
            </div>
          )}
          {colliding && collisionFile && (
            // Sits between the repo/branch chip and the tokens row — reads as
            // another piece of "where this session is" metadata. Subtle danger
            // tint (no border), explicit Also-editing prefix, full path that
            // wraps if long, dedicated × dismiss top-right.
            <div className="mt-1.5 flex items-start gap-1.5 px-2 py-1 rounded bg-danger/10">
              {/* mt-[5px] aligns the 8px dot's center with the first text line. */}
              <span
                aria-hidden
                className="collision-dot shrink-0 inline-block w-2 h-2 rounded-full mt-[5px]"
              />
              <div className="text-[12px] leading-snug min-w-0 flex-1">
                <span className="text-danger font-medium">Also editing </span>
                <span className="font-mono text-fg/90 break-all">
                  {trimToRepoPath(collisionFile, session)}
                </span>
              </div>
              {collisionLogin && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void window.chatheads.collision.dismiss(collisionLogin);
                  }}
                  aria-label="Dismiss collision warning"
                  title="Dismiss"
                  className="shrink-0 -mr-1 px-1.5 py-0 text-[14px] leading-none text-subtle hover:text-fg rounded cursor-pointer"
                >
                  ×
                </button>
              )}
            </div>
          )}
          {(status !== null || tokensLabel !== null) && (
            <div className="mt-1 flex items-center gap-2 text-[11.5px] text-subtle min-w-0">
              <ProviderIcon source={session.source} />
              {tokensLabel && <span className="shrink-0">{tokensLabel}</span>}
              {status && (
                <span className={`shrink-0 ml-auto ${status.isLive ? "text-accent" : ""}`}>
                  {status.isLive ? <WorkingIndicator /> : status.text}
                </span>
              )}
            </div>
          )}
        </div>
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
  const hasAnything = Boolean(summary) || highlights.length > 0 || recent.length > 0;
  return (
    <div className="px-lg pb-lg space-y-md">
      {summary && (
        <div>
          <SubHeader>Summary</SubHeader>
          <Markdown className="mt-1 text-[13px] [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1">
            {summary}
          </Markdown>
        </div>
      )}
      {highlights.length > 0 && (
        <div>
          <SubHeader>Highlights</SubHeader>
          <ul className="mt-1 text-[12.5px] text-fg/90 space-y-0.5 list-disc list-inside marker:text-subtle">
            {highlights.map((h, i) => (
              <li key={i}>
                <Markdown inline>{h}</Markdown>
              </li>
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
      {!hasAnything && <div className="text-[12px] text-subtle">No activity yet.</div>}
    </div>
  );
}

function ActivityRow({ event }: { event: RecentEvent }): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <ArrowIcon />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-fg leading-snug break-words">{event.summary}</div>
        <div className="mt-0.5 text-[11.5px] text-subtle">{fmtAgo(event.ts)}</div>
      </div>
    </div>
  );
}

function fmtTokens(tokens: TokenUsage | undefined): string | null {
  if (!tokens) return null;
  // Exclude cacheRead: with prompt caching, the same cached prefix is re-read
  // every turn, so summing it across turns multiplies unique tokens by the
  // turn count. cacheWrite already accounts for what's in the cache.
  const total = tokens.in + tokens.out + tokens.cacheWrite + tokens.reasoning;
  if (total <= 0) return null;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${total}`;
}

interface StatusInfo {
  text: string;
  isLive: boolean;
}

function statusLabel(s: InfoSession): StatusInfo | null {
  switch (s.state) {
    case SessionState.BUSY:
    case SessionState.ACTIVE:
      return { text: "working now", isLive: true };
    case SessionState.IDLE:
      return {
        text: s.idleS != null ? `idle ${fmtDuration(s.idleS)}` : "idle",
        isLive: false,
      };
    case SessionState.RECENT:
      return s.lastTs ? { text: `paused ${fmtAgo(s.lastTs)}`, isLive: false } : null;
    case SessionState.ENDED:
      return s.lastTs ? { text: `ended ${fmtAgo(s.lastTs)}`, isLive: false } : null;
    default:
      return null;
  }
}

function WorkingIndicator(): JSX.Element {
  const text = "working now...";
  const duration = 1.6;
  const step = 0.08;
  return (
    <span aria-label={text}>
      {Array.from(text).map((ch, i) => {
        const style: CSSProperties = {
          animation: `shimmer-char ${duration}s ease-in-out infinite`,
          animationDelay: `${i * step}s`,
          display: "inline-block",
          whiteSpace: "pre",
        };
        return (
          <span key={i} style={style} aria-hidden>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

function ProviderIcon({ source }: { source: EventSource }): JSX.Element {
  const label = source === "codex" ? "OpenAI Codex" : "Claude Code";
  return (
    <span className="shrink-0 text-subtle" title={label} aria-label={label}>
      {source === "codex" ? <OpenAIIcon /> : <ClaudeIcon />}
    </span>
  );
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
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
