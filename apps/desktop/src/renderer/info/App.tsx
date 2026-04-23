import { useEffect, useRef, useState } from "react";
import { SessionState } from "@slashtalk/shared";
import type { ChatHead, InfoSession } from "../../shared/types";
import { useAutoResize } from "../shared/useAutoResize";

const REFRESH_MS = 15_000;

const DOT_COLOR: Record<SessionState, string> = {
  [SessionState.BUSY]: "bg-warning",
  [SessionState.ACTIVE]: "bg-success",
  [SessionState.IDLE]: "bg-warning",
  [SessionState.RECENT]: "bg-muted",
  [SessionState.ENDED]: "bg-muted",
};

export function App(): JSX.Element {
  const [head, setHead] = useState<ChatHead | null>(null);
  const [sessions, setSessions] = useState<InfoSession[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoResize();

  useEffect(() => {
    const offShow = window.chatheads.onInfoShow((p) => {
      setHead(p.head);
      setSessions(p.sessions);
    });
    const offHide = window.chatheads.onInfoHide(() => setHead(null));
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
    // Initial payload is already sent by main; only refresh on interval.
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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

  useEffect(() => {
    // Use `mousedown` (not `click`) so we check containment BEFORE any React
    // state update has remounted the clicked node. With `click`, expanding
    // the accordion caused `e.target` to detach mid-event and contains() to
    // return false, falsely firing hideInfo.
    const handleMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        void window.chatheads.hideInfo();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  return (
    <div ref={rootRef} className="bg-card rounded-lg">
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
  return (
    <div className="flex items-start gap-md px-lg pt-lg pb-md">
      <Avatar head={head} />
      <div className="flex-1 min-w-0">
        <div className="text-[19px] font-bold leading-tight truncate">
          {name}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted whitespace-nowrap min-w-0">
          <span className="text-warning shrink-0">☀︎</span>
          <span className="truncate">New York</span>
          <span className="text-subtle shrink-0">·</span>
          <span className="shrink-0">{time}</span>
          <span className="text-subtle shrink-0">·</span>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-success/15 text-success text-[11px] font-medium shrink-0">
            <Dot color="bg-success" />
            active
          </span>
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
    <div className="px-lg pt-md pb-lg">
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
  const hasExpandable =
    Boolean(session.rollingSummary) ||
    Boolean(session.highlights && session.highlights.length > 0);
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => hasExpandable && setExpanded((v) => !v)}
        className={`flex items-center gap-2 w-full text-left ${
          hasExpandable ? "cursor-pointer" : "cursor-default"
        }`}
        aria-expanded={hasExpandable ? expanded : undefined}
      >
        <Dot color={DOT_COLOR[session.state]} />
        <div className="text-[14px] text-fg flex-1 truncate">{title}</div>
        {hasExpandable && <Chevron open={expanded} />}
      </button>
      {session.description && (
        <div className="mt-1 text-[12px] text-muted line-clamp-2 pl-3.5">
          {session.description}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted min-w-0">
        {(repo || session.branch) && (
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
        )}
        <span className="text-subtle shrink-0">·</span>
        <span className="inline-flex items-center gap-1 shrink-0">
          <span className="text-subtle">✦</span>
          <span>{toolLabel(session.kind, session.model)}</span>
        </span>
      </div>
      {status && <div className="mt-1.5 text-[12px] text-muted">{status}</div>}
      {expanded && hasExpandable && (
        <div className="mt-2 pl-3.5 space-y-1.5">
          {session.rollingSummary && (
            <div className="text-[12px] text-fg/85 leading-relaxed">
              {session.rollingSummary}
            </div>
          )}
          {session.highlights && session.highlights.length > 0 && (
            <ul className="text-[11.5px] text-muted space-y-0.5 list-disc list-inside">
              {session.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          )}
        </div>
      )}
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
  if (h < 24) return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function Dot({ color }: { color: string }): JSX.Element {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color}`} />;
}

function Chevron({ open = false }: { open?: boolean }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={`text-subtle shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <path
        d="M3 4.5 L6 7.5 L9 4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
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
