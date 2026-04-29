import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ProjectOverviewResponse,
  QuotaByLogin,
  QuotaPresence,
  SpotifyPresence,
  TokenUsage,
} from "@slashtalk/shared";
import type { ChatHead, InfoDashboardData, InfoSession, UserLocation } from "../../shared/types";
import { AgentPanel } from "./AgentPanel";
import { HierarchyDashboard } from "./HierarchyDashboard";
import { ProjectDashboard } from "./ProjectDashboard";
import { useAutoResize } from "../shared/useAutoResize";
import { useLocationWeather } from "../shared/useLocationWeather";
import { ClaudeIcon, SpotifyIcon } from "../shared/icons";

const REFRESH_MS = 15_000;

export function App(): JSX.Element {
  const [head, setHead] = useState<ChatHead | null>(null);
  const [sessions, setSessions] = useState<InfoSession[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [spotify, setSpotify] = useState<SpotifyPresence | null>(null);
  const [quota, setQuota] = useState<QuotaByLogin | null>(null);
  const [location, setLocation] = useState<UserLocation | null>(null);
  const [isSelf, setIsSelf] = useState(false);
  const [dashboard, setDashboard] = useState<InfoDashboardData | null>(null);
  const [dashboardFetching, setDashboardFetching] = useState(false);
  const [projectOverview, setProjectOverview] = useState<ProjectOverviewResponse | null>(null);
  const [projectOverviewFetching, setProjectOverviewFetching] = useState(false);
  // Bumped on every `info:show` to drive the post-commit ack effect. Lets us
  // ack same-head re-shows where head?.id is unchanged.
  const [showNonce, setShowNonce] = useState(0);
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
      setQuota(p.quota);
      setLocation(p.location);
      setIsSelf(p.isSelf);
      setDashboard(p.dashboard);
      setDashboardFetching(p.dashboardFetching);
      setProjectOverview(p.projectOverview);
      setProjectOverviewFetching(p.projectOverviewFetching);
      setVisible(true);
      setShowNonce((n) => n + 1);
    });
    // Keep head/sessions/spotify on hide so the last content fades out instead
    // of collapsing; next show replaces them wholesale.
    const offHide = window.chatheads.onInfoHide(() => setVisible(false));
    const offPresence = window.chatheads.onInfoPresence((p) => {
      // Main already filtered to the visible head, but double-check in case
      // a hide → show raced between the two events.
      setHead((h) => {
        if (h && h.label === p.login) {
          setSpotify(p.spotify);
          setQuota(p.quota);
        }
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
    if (head.kind === "agent" || head.kind === "project") {
      // Project heads don't have per-head sessions; agent heads route their
      // own data path. Skip the user-flavored session refresh loop.
      setSessions([]);
      return;
    }
    let cancelled = false;
    const headLogin = head.label;
    const load = async (): Promise<void> => {
      try {
        const [rows, sp, qu] = await Promise.all([
          window.chatheads.listSessionsForHead(head.id),
          window.chatheads.getSpotifyForLogin(headLogin),
          window.chatheads.getQuotaForLogin(headLogin),
        ]);
        if (cancelled) return;
        setSessions(rows);
        setSpotify(sp);
        setQuota(qu);
      } catch {
        if (!cancelled) setSessions([]);
      }
    };
    // Sessions may be preloaded by main via onInfoShow — skip the redundant
    // refetch in that case. Always start the 15s tick so the "Now" status
    // stays live.
    if (sessions === null) void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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

  // Ack each `info:show` synchronously after React commits the new content,
  // before the browser paints. Includes the measured inner-content height so
  // main can size + place the window correctly on the first setBounds — no
  // overflow-then-snap when the new card is taller than the previous one.
  // Measures the same inner ref `useAutoResize` does, so the height we ack
  // matches the value `requestResize` would otherwise send a frame later.
  useLayoutEffect(() => {
    if (showNonce === 0) return;
    const h = contentRef.current?.getBoundingClientRect().height ?? 0;
    window.chatheads.notifyInfoShowReady(Math.ceil(h));
  }, [showNonce]);

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => void window.chatheads.infoHoverEnter()}
      onMouseLeave={() => void window.chatheads.infoHoverLeave()}
      className="bg-surface-2 h-screen overflow-y-auto transition-[opacity,transform] duration-75 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateX(0)" : "translateX(-4px)",
      }}
    >
      <div ref={contentRef}>
        {head?.kind === "agent" ? (
          <AgentPanel head={head} />
        ) : head?.kind === "project" ? (
          <ProjectDashboard
            repoFullName={head.repoFullName ?? head.label}
            overview={projectOverview}
            fetching={projectOverviewFetching}
          />
        ) : (
          <>
            <UserHeader
              head={head}
              sessions={sessions}
              location={location}
              isSelf={isSelf}
              spotify={spotify}
              quota={quota}
            />
            <HierarchyDashboard
              sessions={sessions}
              dashboard={dashboard}
              dashboardFetching={dashboardFetching}
              subjectLabel={isSelf ? "my" : `${head?.label ?? "their"}'s`}
            />
          </>
        )}
      </div>
    </div>
  );
}

function sourceLabel(source: QuotaPresence["source"]): string {
  if (source === "claude") return "Claude";
  if (source === "codex") return "Codex";
  return "Cursor";
}

function fmtResetsIn(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  // The wire schema accepts any string for resetsAt, so a buggy collector or
  // a future source could hand us garbage. Detect the unparseable case
  // explicitly — otherwise NaN math falls through to "now", which would lie
  // to the user about a window having just reset.
  const t = new Date(resetsAt).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return "now";
  // Compute every unit from `ms` directly (not from the next-larger unit's
  // already-rounded value) — otherwise compounding rounding can skip a label.
  // E.g. 47.5h via Math.round(mins/60) becomes 48, but `hours < 48` is false,
  // so the display jumps "47h" → "2d" with "48h" never appearing. `floor`
  // gives stable, downward-biased "time-until" semantics: each label sticks
  // until you actually cross into the next unit.
  const mins = Math.floor(ms / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(ms / 86_400_000);
  return `${days}d`;
}

function Quotas({ quota }: { quota: QuotaByLogin }): JSX.Element | null {
  const sources = Object.values(quota).filter((q): q is QuotaPresence => Boolean(q));
  if (sources.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {sources.map((q) => (
        <QuotaRow key={q.source} quota={q} />
      ))}
    </div>
  );
}

function QuotaRow({ quota }: { quota: QuotaPresence }): JSX.Element {
  const hasWindows = quota.windows.length > 0;
  return (
    <div className="flex items-center gap-2 text-sm leading-tight min-w-0">
      <span className="text-fg font-medium shrink-0">{sourceLabel(quota.source)}</span>
      {quota.plan && (
        <>
          <span className="text-subtle shrink-0">·</span>
          <span className="text-muted shrink-0 capitalize">{quota.plan}</span>
        </>
      )}
      {hasWindows && (
        <>
          <span className="text-subtle shrink-0">·</span>
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {quota.windows.map((w, i) => {
              const used = w.usedPercent ?? null;
              const resetIn = fmtResetsIn(w.resetsAt);
              return (
                <span key={`${w.label}-${i}`} className="text-muted whitespace-nowrap">
                  <span className="text-fg">{used !== null ? `${Math.round(used)}%` : "—"}</span>
                  <span className="text-subtle"> {w.label}</span>
                  {resetIn && <span className="text-subtle"> · resets {resetIn}</span>}
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function NowPlayingRow({ track }: { track: SpotifyPresence }): JSX.Element {
  const open = (): void => {
    void window.chatheads.openExternal(track.url);
  };
  return (
    <button
      type="button"
      onClick={open}
      title={`Open on Spotify: ${track.name} — ${track.artist}`}
      className="mt-1 flex items-center gap-1.5 text-sm text-muted min-w-0 group cursor-pointer w-full text-left"
    >
      <span className="shrink-0">
        <SpotifyIcon />
      </span>
      <span className="truncate min-w-0">
        <span className="text-fg">{track.name}</span>
        <span className="text-subtle"> — </span>
        <span>{track.artist}</span>
      </span>
    </button>
  );
}

function formatHeaderTime(timeZone: string | null | undefined): string | null {
  try {
    return new Date().toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return null;
  }
}

function headerTime(
  showLocationRow: boolean,
  isSelf: boolean,
  peerTz: string | null,
): string | null {
  if (!showLocationRow) return null;
  if (isSelf) return formatHeaderTime(null);
  return peerTz ? formatHeaderTime(peerTz) : null;
}

function UserHeader({
  head,
  sessions,
  location,
  isSelf,
  spotify,
  quota,
}: {
  head: ChatHead | null;
  sessions: InfoSession[] | null;
  location: UserLocation | null;
  isSelf: boolean;
  spotify?: SpotifyPresence | null;
  quota?: QuotaByLogin | null;
}): JSX.Element {
  const name = head?.label ?? "—";
  // Self: resolve locally as before. Peer with data: show their tz/city.
  // Peer with no server data yet: render only name + avatar — falling back
  // to local would mislabel the peer's card with our clock.
  const { city, icon } = useLocationWeather(isSelf ? undefined : location);
  const showLocationRow = isSelf || location !== null;
  // Self uses the device's local tz so travel doesn't lock the clock to a
  // stale peer-poll cache. For peers, fall back to skipping the clock when
  // the server hasn't sent a tz yet — using the viewer's local would
  // mislabel it as the peer's.
  const time = headerTime(showLocationRow, isSelf, location?.timezone ?? null);
  const totalTokensLabel = fmtTokens(sumSessionTokens(sessions));
  return (
    <div className="flex items-start gap-3 px-4 pt-4 pb-3">
      <Avatar head={head} />
      <div className="flex-1 min-w-0">
        <div className="text-lg font-bold leading-tight truncate">{name}</div>
        {showLocationRow && (
          <div className="mt-1 flex items-center gap-1.5 text-sm text-muted whitespace-nowrap min-w-0">
            {city && (
              <>
                {icon && <span className="shrink-0">{icon}</span>}
                <span className="truncate">{city}</span>
                {time && <span className="text-subtle shrink-0">·</span>}
              </>
            )}
            {time && <span className="shrink-0">{time}</span>}
          </div>
        )}
        {totalTokensLabel && (
          <div className="mt-1 flex items-center gap-1.5 text-sm text-muted">
            <ClaudeIcon />
            <span>{totalTokensLabel} tokens</span>
          </div>
        )}
        {spotify && <NowPlayingRow track={spotify} />}
        {quota && <Quotas quota={quota} />}
      </div>
    </div>
  );
}

function sumSessionTokens(sessions: InfoSession[] | null): TokenUsage | undefined {
  if (!sessions || sessions.length === 0) return undefined;
  const total: TokenUsage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let any = false;
  for (const s of sessions) {
    const t = s.tokens;
    if (!t) continue;
    any = true;
    total.in += t.in;
    total.out += t.out;
    total.cacheRead += t.cacheRead;
    total.cacheWrite += t.cacheWrite;
    total.reasoning += t.reasoning;
  }
  return any ? total : undefined;
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
  const tint = head?.tint ?? "var(--color-surface-alt)";
  return (
    <div className="relative w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0 overflow-hidden">
      <div className="absolute inset-0 rounded-full opacity-30" style={{ background: tint }} />
      <span className="relative leading-none">{emoji}</span>
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
