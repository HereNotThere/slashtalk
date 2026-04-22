import { useEffect, useState } from "react";
import type { ChatHead } from "../../shared/types";
import { useAutoResize } from "../shared/useAutoResize";

// All data here is hard-coded — real data will come from the session/feed
// backend (see CLAUDE.md "Implementation status"). Shapes mirror what we
// expect once ingest aggregates land.

type Session = {
  title: string;
  repo: string;
  branch: string;
  tool: string;
  status:
    | { kind: "active"; duration: string }
    | { kind: "paused"; since: string };
};

const SESSIONS: Session[] = [
  {
    title: "Simplifying the sign up flow",
    repo: "towns-app",
    branch: "feat/auth-cleanup",
    tool: "Claude",
    status: { kind: "active", duration: "1h 12m" },
  },
  {
    title: "Redesigning the home page",
    repo: "towns-app",
    branch: "user/fei",
    tool: "Claude",
    status: { kind: "paused", since: "2h" },
  },
];

type FeedEntry = {
  age: string;
  tone: "success" | "info" | "fg";
  text: string;
};

const FEED: FeedEntry[] = [
  { age: "14m", tone: "success", text: "Handled duplicate-email 409 as field error." },
  { age: "41m", tone: "success", text: "Added zod validation + SIGNUP_ERRORS map." },
  { age: "1h", tone: "info", text: "Opened feat/auth-cleanup from main." },
  { age: "3h", tone: "fg", text: "Closed home-page hero explorations — parked." },
];

export function App(): JSX.Element {
  const [head, setHead] = useState<ChatHead | null>(null);
  useAutoResize();

  useEffect(() => {
    return window.chatheads.onInfoShow((p) => setHead(p.head));
  }, []);

  return (
    <>
      <Header head={head} />
      <Divider />
      <SessionsSection />
      <Divider />
      <FeedSection />
    </>
  );
}

function Divider(): JSX.Element {
  return <div className="h-px bg-divider" />;
}

function Header({ head }: { head: ChatHead | null }): JSX.Element {
  const name = head?.label ?? "—";
  return (
    <div className="flex items-start gap-md px-lg pt-lg pb-md">
      <Avatar head={head} />
      <div className="flex-1 min-w-0">
        <div className="text-[19px] font-bold leading-tight truncate">{name}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
          <span className="text-warning">☀︎</span>
          <span>San Francisco</span>
          <span className="text-subtle">·</span>
          <span>8:47 AM</span>
          <span className="text-subtle">·</span>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-success/15 text-success text-[11px] font-medium">
            <Dot color="bg-success" />
            active
          </span>
        </div>
      </div>
      <div className="w-6 h-6 rounded-full bg-surface flex items-center justify-center text-muted text-[11px] leading-none shrink-0">
        ✕
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

function SessionsSection(): JSX.Element {
  return (
    <div className="px-lg pt-md pb-lg">
      <SectionHeader title={`Sessions · ${SESSIONS.length}`} trailing="last 24h" />
      <div className="mt-md space-y-lg">
        {SESSIONS.map((s) => (
          <SessionRow key={s.title} session={s} />
        ))}
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: Session }): JSX.Element {
  const dotColor = session.status.kind === "active" ? "bg-success" : "bg-warning";
  return (
    <div>
      <div className="flex items-center gap-2">
        <Dot color={dotColor} />
        <div className="text-[14px] font-semibold text-fg flex-1 truncate">
          {session.title}
        </div>
        <Chevron />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted flex-wrap">
        <span className="inline-flex items-center gap-1.5 font-mono bg-code rounded-md px-1.5 py-0.5 text-fg/85">
          <BranchIcon />
          <span>{session.repo}</span>
          <span className="text-subtle">·</span>
          <span>{session.branch}</span>
        </span>
        <span className="text-subtle">·</span>
        <span className="inline-flex items-center gap-1">
          <span className="text-subtle">✦</span>
          <span>{session.tool}</span>
        </span>
        {session.status.kind === "paused" && (
          <>
            <span className="text-subtle">·</span>
            <span>paused {session.status.since}</span>
          </>
        )}
      </div>
      {session.status.kind === "active" && (
        <div className="mt-1.5 text-[12px] text-muted">
          {session.status.duration}
        </div>
      )}
    </div>
  );
}

function FeedSection(): JSX.Element {
  return (
    <div className="px-lg pt-md pb-lg">
      <SectionHeader title="24h Feed" trailing="derived" />
      <div className="mt-md space-y-sm">
        {FEED.map((e, i) => (
          <FeedRow key={i} entry={e} />
        ))}
      </div>
    </div>
  );
}

function FeedRow({ entry }: { entry: FeedEntry }): JSX.Element {
  const toneClass =
    entry.tone === "success"
      ? "bg-success"
      : entry.tone === "info"
        ? "bg-info"
        : "bg-fg";
  return (
    <div className="flex items-center gap-2.5 text-[13px]">
      <span className="w-7 text-[11.5px] text-subtle text-right tabular-nums shrink-0">
        {entry.age}
      </span>
      <Dot color={toneClass} />
      <span className="text-fg/90 flex-1">{entry.text}</span>
    </div>
  );
}

function Dot({ color }: { color: string }): JSX.Element {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color}`} />;
}

function Chevron(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className="text-subtle shrink-0"
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
