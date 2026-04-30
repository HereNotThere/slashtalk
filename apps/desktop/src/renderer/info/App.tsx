import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectOverviewResponse, SpotifyPresence, TokenUsage } from "@slashtalk/shared";
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
  const [location, setLocation] = useState<UserLocation | null>(null);
  const [isSelf, setIsSelf] = useState(false);
  const [dashboard, setDashboard] = useState<InfoDashboardData | null>(null);
  const [dashboardFetching, setDashboardFetching] = useState(false);
  const [projectOverview, setProjectOverview] = useState<ProjectOverviewResponse | null>(null);
  const [projectOverviewFetching, setProjectOverviewFetching] = useState(false);
  // Bumped on every `info:show` to drive the post-commit ack effect. Lets us
  // ack same-head re-shows where head?.id is unchanged.
  const [showNonce, setShowNonce] = useState(0);
  // Tracks the head id from the previous info:show so we can tell a same-head
  // refetch (keep prior content; the fetching flag drives a fade) from a
  // head-switch (replace wholesale). Refs not state — we only need the value
  // synchronously inside the IPC handler.
  const prevHeadIdRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Measure the inner content, not the card: the card is capped at max-h-screen
  // so its height saturates at the window size and wouldn't signal growth.
  useAutoResize(contentRef);

  useEffect(() => {
    const offShow = window.chatheads.onInfoShow((p) => {
      const sameHead = prevHeadIdRef.current === p.head.id;
      prevHeadIdRef.current = p.head.id;
      setHead(p.head);
      // Same-head re-show: SWR semantics — only overwrite when the snapshot
      // carries data, so a cache-cleared push (dashboard=null, fetching=true)
      // doesn't wipe the visible content. The fetching flags below still
      // update so the dashboards can fade their stale content during the
      // in-flight refetch. Head-switch: replace wholesale; showing user A's
      // content on user B's card would be misleading.
      if (sameHead) {
        if (p.sessions !== null) setSessions(p.sessions);
        if (p.dashboard !== null) setDashboard(p.dashboard);
        if (p.projectOverview !== null) setProjectOverview(p.projectOverview);
      } else {
        setSessions(p.sessions);
        setDashboard(p.dashboard);
        setProjectOverview(p.projectOverview);
      }
      setSpotify(p.spotify);
      setLocation(p.location);
      setIsSelf(p.isSelf);
      setDashboardFetching(p.dashboardFetching);
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
        const [rows, sp] = await Promise.all([
          window.chatheads.listSessionsForHead(head.id),
          window.chatheads.getSpotifyForLogin(headLogin),
        ]);
        if (cancelled) return;
        setSessions(rows);
        setSpotify(sp);
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
      className="bg-surface-2 h-screen overflow-y-auto transition-[opacity,transform] duration-75 ease-out select-text"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateX(0)" : "translateX(-4px)",
      }}
    >
      <div ref={contentRef} className={head?.kind === "agent" ? undefined : "pb-2"}>
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
}: {
  head: ChatHead | null;
  sessions: InfoSession[] | null;
  location: UserLocation | null;
  isSelf: boolean;
  spotify?: SpotifyPresence | null;
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
