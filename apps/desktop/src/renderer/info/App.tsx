import { useEffect, useRef, useState } from "react";
import { SessionState } from "@slashtalk/shared";
import type { ChatHead, InfoSession } from "../../shared/types";
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
  useAutoResize();

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
      className="bg-card rounded-lg transition-[opacity,transform] duration-75 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateX(0)" : "translateX(-4px)",
      }}
    >
      <Header head={head} />
      <Divider />
      <SessionsSection sessions={sessions} />
    </div>
  );
}

function Divider(): JSX.Element {
  return <div className="h-px bg-divider" />;
}

function Header({ head }: { head: ChatHead | null }): JSX.Element {
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

function SectionHeader({
  title,
  trailing,
}: {
  title: string;
  trailing: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <div className="text-[11px] font-semibold tracking-wider uppercase text-subtle">
        {title}
      </div>
      <div className="text-[11px] text-subtle">{trailing}</div>
    </div>
  );
}

function SessionsSection({
  sessions,
}: {
  sessions: InfoSession[] | null;
}): JSX.Element {
  const title = sessions == null ? "Sessions" : `Sessions · ${sessions.length}`;
  return (
    <div className="px-lg pt-md pb-lg min-h-[120px]">
      <SectionHeader title={title} trailing="last 24h" />
      <div className="mt-md space-y-lg">
        {sessions == null ? (
          <div className="text-[12px] text-subtle">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="text-[12px] text-subtle">No sessions yet.</div>
        ) : (
          sessions.map((s) => <SessionRow key={s.id} session={s} />)
        )}
      </div>
    </div>
  );
}

function repoLabel(s: InfoSession): string | null {
  if ("repo_full_name" in s && s.repo_full_name) return s.repo_full_name;
  // Fallback for own sessions: Claude writes projects as a slugified cwd path
  // (e.g. "-Users-erik-dev-towns-app"); the trailing segment is the repo dir.
  const parts = s.project.split(/[-/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

function toolLabel(kind: string | null, model: string | null): string {
  if (kind === "codex") return "Codex";
  if (kind === "claude") return "Claude";
  if (model?.toLowerCase().includes("gpt")) return "Codex";
  return "Claude";
}

function SessionRow({ session }: { session: InfoSession }): JSX.Element {
  const repo = repoLabel(session);
  const title = session.title ?? session.lastUserPrompt ?? "Untitled session";
  const status = statusLabel(session);
  const tool = toolLabel(session.kind, session.model);
  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="mt-[7px] shrink-0 inline-flex">
          <Dot color={DOT_COLOR[session.state]} />
        </span>
        <div className="text-[14px] leading-5 text-fg flex-1 min-w-0 whitespace-normal break-words">
          {title}
        </div>
      </div>
      {(repo || session.branch) && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted min-w-0">
          <span className="inline-flex items-center gap-1.5 font-mono bg-code rounded-md px-1.5 py-0.5 text-fg/85 min-w-0 max-w-full whitespace-nowrap overflow-hidden">
            <BranchIcon />
            {repo && <span className="truncate">{repo}</span>}
            {repo && session.branch && (
              <span className="text-subtle shrink-0">·</span>
            )}
            {session.branch && (
              <span className="truncate">{session.branch}</span>
            )}
          </span>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
        {status && <span>{status}</span>}
        {status && <span className="text-subtle shrink-0">·</span>}
        <span className="inline-flex items-center gap-1 shrink-0">
          {tool === "Claude" ? (
            <ClaudeIcon />
          ) : (
            <span className="text-subtle">✦</span>
          )}
          <span>{tool}</span>
        </span>
      </div>
    </div>
  );
}

function statusLabel(s: InfoSession): string | null {
  switch (s.state) {
    case SessionState.BUSY:
      return "working now";
    case SessionState.ACTIVE:
      return s.durationS != null ? fmtDuration(s.durationS) : null;
    case SessionState.IDLE:
      return s.idleS != null ? `idle ${fmtDuration(s.idleS)}` : null;
    case SessionState.RECENT:
      return s.idleS != null ? `paused ${fmtDuration(s.idleS)}` : null;
    case SessionState.ENDED:
      return s.idleS != null ? `ended ${fmtDuration(s.idleS)} ago` : null;
  }
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  const roundedH = rem >= 30 ? h + 1 : h;
  if (roundedH < 24) return `${roundedH}h`;
  const d = Math.floor(roundedH / 24);
  return `${d}d`;
}

function Dot({ color }: { color: string }): JSX.Element {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color}`} />;
}

function ClaudeIcon(): JSX.Element {
  return (
    <svg
      width="11"
      height="12"
      viewBox="0 0 13 14"
      fill="none"
      className="text-subtle shrink-0"
      aria-hidden
    >
      <path
        d="M 2.55 9.31 L 5.108 7.765 L 5.151 7.631 L 5.108 7.557 L 4.984 7.556 L 4.556 7.528 L 3.094 7.486 L 1.827 7.429 L 0.599 7.358 L 0.29 7.287 L 0 6.876 L 0.03 6.671 L 0.29 6.483 L 0.662 6.518 L 1.484 6.579 L 2.719 6.67 L 3.614 6.727 L 4.941 6.875 L 5.151 6.875 L 5.181 6.784 L 5.109 6.727 L 5.053 6.67 L 3.776 5.739 L 2.393 4.754 L 1.669 4.187 L 1.277 3.9 L 1.08 3.631 L 0.995 3.043 L 1.35 2.622 L 1.828 2.657 L 1.95 2.692 L 2.433 3.092 L 3.467 3.953 L 4.816 5.023 L 5.013 5.199 L 5.092 5.139 L 5.102 5.096 L 5.013 4.937 L 4.279 3.509 L 3.496 2.057 L 3.148 1.455 L 3.056 1.094 C 3.023 0.946 3 0.821 3 0.669 L 3.404 0.077 L 3.628 0 L 4.168 0.077 L 4.395 0.29 L 4.731 1.116 L 5.274 2.416 L 6.117 4.184 L 6.364 4.708 L 6.495 5.194 L 6.544 5.342 L 6.629 5.342 L 6.629 5.257 L 6.699 4.261 L 6.827 3.038 L 6.952 1.465 L 6.995 1.022 L 7.198 0.491 L 7.603 0.204 L 7.919 0.367 L 8.179 0.767 L 8.143 1.026 L 7.988 2.107 L 7.685 3.8 L 7.488 4.934 L 7.603 4.934 L 7.735 4.792 L 8.268 4.031 L 9.163 2.826 L 9.558 2.348 L 10.019 1.82 L 10.315 1.568 L 10.874 1.568 L 11.286 2.227 L 11.101 2.907 L 10.525 3.693 L 10.048 4.359 L 9.363 5.351 L 8.936 6.145 L 8.975 6.208 L 9.077 6.198 L 10.624 5.843 L 11.459 5.681 L 12.457 5.497 L 12.908 5.724 L 12.957 5.954 L 12.78 6.426 L 11.713 6.709 L 10.462 6.978 L 8.599 7.453 L 8.577 7.471 L 8.603 7.505 L 9.442 7.591 L 9.801 7.611 L 10.68 7.611 L 12.316 7.743 L 12.744 8.047 L 13 8.419 L 12.957 8.703 L 12.299 9.063 L 11.41 8.837 L 9.337 8.306 L 8.626 8.115 L 8.527 8.115 L 8.527 8.178 L 9.12 8.802 L 10.206 9.857 L 11.566 11.218 L 11.635 11.554 L 11.46 11.819 L 11.276 11.791 L 10.081 10.824 L 9.62 10.388 L 8.577 9.442 L 8.507 9.442 L 8.507 9.541 L 8.748 9.92 L 10.018 11.975 L 10.084 12.605 L 9.992 12.811 L 9.662 12.934 L 9.301 12.863 L 8.557 11.74 L 7.79 10.475 L 7.171 9.341 L 7.096 9.387 L 6.73 13.621 L 6.559 13.837 L 6.164 14 L 5.835 13.731 L 5.66 13.295 L 5.835 12.434 L 6.046 11.311 L 6.217 10.418 L 6.371 9.309 L 6.464 8.941 L 6.457 8.916 L 6.382 8.926 L 5.605 10.074 L 4.423 11.793 L 3.489 12.87 L 3.265 12.965 L 2.877 12.749 L 2.913 12.363 L 4.423 10.247 L 5.204 9.149 L 5.708 8.515 L 5.704 8.424 L 5.674 8.424 L 2.238 10.825 L 1.626 10.911 L 1.362 10.645 L 1.395 10.209 L 1.52 10.068 L 2.553 9.302 L 2.549 9.306 L 2.55 9.31 Z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  );
}

function BranchIcon(): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      className="text-subtle shrink-0"
      aria-hidden
    >
      <circle cx="3" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="3" cy="9.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="9" cy="4" r="1.2" stroke="currentColor" strokeWidth="1" />
      <path
        d="M3 3.7 L3 8.3 M3 6 Q3 4 5 4 L7.8 4"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
