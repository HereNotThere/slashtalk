import { Fragment, useState, type CSSProperties, type MouseEvent } from "react";
import { BoltIcon, ChatBubbleLeftIcon, ClockIcon, FolderIcon } from "@heroicons/react/24/outline";
import { SessionState } from "@slashtalk/shared";
import type { EventSource, TokenUsage } from "@slashtalk/shared";
import type { InfoSession } from "../../shared/types";
import { ClaudeIcon, OpenAIIcon } from "../shared/icons";
import { relativeTime } from "../shared/relativeTime";
import { AskInput } from "./AskInline";
import { MOCK_PRS, MOCK_STANDUP, type MockPr } from "./mock-data";

const PR_STATE_COLOR: Record<MockPr["state"], string> = {
  open: "text-success",
  merged: "text-info",
  closed: "text-danger",
  draft: "text-muted",
};

const PR_STATE_LABEL: Record<MockPr["state"], string> = {
  open: "open",
  merged: "merged",
  closed: "closed",
  draft: "draft",
};

const NOW_WINDOW_MS = 2 * 60 * 60 * 1000; // last 2 hours

export function HierarchyDashboard({ sessions }: { sessions: InfoSession[] | null }): JSX.Element {
  const nowSession = pickNowSession(sessions);
  return (
    <>
      <Divider />
      {nowSession && (
        <>
          <NowSection session={nowSession} />
          <Divider />
        </>
      )}
      <PastDaySection />
      <Divider />
      <PrsSection />
    </>
  );
}

function Divider(): JSX.Element {
  return <div className="mx-4 h-px bg-divider" />;
}

function PlainHeader({ label }: { label: string }): JSX.Element {
  return (
    <div className="px-4 pt-3 pb-1.5">
      <span className="text-xs font-semibold tracking-wider uppercase text-subtle">{label}</span>
    </div>
  );
}

function AskTrigger({
  onClick,
  className,
}: {
  onClick: (e: MouseEvent) => void;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      title="Ask a question"
      aria-label="Ask a question"
      className={`shrink-0 p-1 rounded text-subtle/70 hover:text-fg hover:bg-surface-alt-hover transition-colors cursor-pointer ${className ?? ""}`}
    >
      <ChatBubbleLeftIcon className="w-3.5 h-3.5" />
    </button>
  );
}

// Pick the session that the "Now" section should describe.
// Priority: any BUSY/ACTIVE session (most recent wins), else the most-recent
// IDLE/RECENT session whose lastTs is within the last 2h. ENDED is excluded.
// Returns null if nothing qualifies — caller hides the section.
function pickNowSession(sessions: InfoSession[] | null): InfoSession | null {
  if (!sessions || sessions.length === 0) return null;
  const cutoff = Date.now() - NOW_WINDOW_MS;
  let bestLive: InfoSession | null = null;
  let bestLiveTs = -Infinity;
  let bestRecent: InfoSession | null = null;
  let bestRecentTs = -Infinity;
  for (const s of sessions) {
    const ts = s.lastTs ? new Date(s.lastTs).getTime() : 0;
    const isLive = s.state === SessionState.BUSY || s.state === SessionState.ACTIVE;
    if (isLive) {
      if (ts > bestLiveTs) {
        bestLiveTs = ts;
        bestLive = s;
      }
      continue;
    }
    if (s.state === SessionState.IDLE || s.state === SessionState.RECENT) {
      if (ts >= cutoff && ts > bestRecentTs) {
        bestRecentTs = ts;
        bestRecent = s;
      }
    }
  }
  return bestLive ?? bestRecent;
}

function NowSection({ session }: { session: InfoSession }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const status = sessionStatus(session);
  const repo = repoLabel(session);
  const tokens = fmtTokens(session.tokens);
  // Prefer the analyzer's 1-2 sentence description; fall back to the user's
  // most recent prompt if a description hasn't been generated yet.
  const summary = session.description ?? session.lastUserPrompt ?? null;
  const title = session.title ?? session.lastUserPrompt ?? "Untitled session";
  return (
    <div>
      <div className="px-4 pt-3 pb-1.5 flex items-center gap-1.5">
        <BoltIcon className="w-3.5 h-3.5 shrink-0 text-info" aria-hidden />
        <span className="text-xs font-semibold tracking-wider uppercase text-subtle">Now</span>
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            {summary && <p className="text-sm text-fg leading-snug">{summary}</p>}
            {(repo || tokens || status) && (
              <div
                className={`${summary ? "mt-1" : ""} flex items-center gap-2 text-[11px] text-subtle min-w-0`}
              >
                {repo && (
                  <span className="inline-flex items-center gap-1 min-w-0">
                    <FolderIcon className="w-3.5 h-3.5 shrink-0" aria-hidden />
                    <span className="font-mono truncate text-fg/75">{repo}</span>
                  </span>
                )}
                {tokens && (
                  <span className="inline-flex items-center gap-1 shrink-0">
                    <ProviderIcon source={session.source} />
                    <span>{tokens}</span>
                  </span>
                )}
                {status && (
                  <span className={`shrink-0 ml-auto ${status.isLive ? "text-info" : ""}`}>
                    {status.isLive ? <WorkingIndicator /> : status.text}
                  </span>
                )}
              </div>
            )}
          </div>
          <AskTrigger onClick={() => setEditing(true)} className="self-end -mb-0.5 -mr-1" />
        </div>
        {editing && (
          <AskInput
            contextLabel={`About my current session "${title}"${repo ? ` in ${repo}` : ""}:`}
            placeholder="Ask about this session…"
            onClose={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}

function PastDaySection(): JSX.Element {
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <div className="px-4 pt-3 pb-1.5 flex items-center gap-1.5">
        <ClockIcon className="w-3.5 h-3.5 shrink-0 text-muted" aria-hidden />
        <span className="text-xs font-semibold tracking-wider uppercase text-subtle">Past Day</span>
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-end gap-2">
          <p className="flex-1 text-sm text-fg/90 leading-snug">{MOCK_STANDUP}</p>
          <AskTrigger onClick={() => setEditing(true)} className="-mb-0.5 -mr-1" />
        </div>
        {editing && (
          <AskInput
            contextLabel="About my past day:"
            placeholder="Ask about your day…"
            onClose={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}

function PrsSection(): JSX.Element {
  return (
    <div>
      <PlainHeader label="PRs pushed" />
      {MOCK_PRS.map((pr, i) => (
        <Fragment key={pr.number}>
          {i > 0 && <div className="mx-4 h-px bg-divider/60" />}
          <PrRow pr={pr} />
        </Fragment>
      ))}
    </div>
  );
}

function PrRow({ pr }: { pr: MockPr }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const openPr = (): void => {
    void window.chatheads.openExternal(pr.url);
  };
  return (
    <div className="px-4 py-2.5 group hover:bg-surface-alt/60 transition-colors">
      <div
        role="button"
        tabIndex={0}
        onClick={openPr}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPr();
          }
        }}
        className="flex items-start gap-2.5 cursor-pointer"
      >
        <PrIcon className={`w-4 h-4 mt-0.5 shrink-0 ${PR_STATE_COLOR[pr.state]}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-fg leading-snug line-clamp-2 group-hover:underline decoration-divider underline-offset-2">
            {pr.title}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-subtle">
            <span className={`font-medium ${PR_STATE_COLOR[pr.state]}`}>#{pr.number}</span>
            <span aria-hidden>·</span>
            <span>{PR_STATE_LABEL[pr.state]}</span>
            <span aria-hidden>·</span>
            <span>{relativeTime(pr.ts)}</span>
          </div>
        </div>
        <AskTrigger onClick={() => setEditing(true)} className="self-end -mb-0.5 -mr-1" />
      </div>
      {editing && (
        <AskInput
          contextLabel={`About PR #${pr.number} — "${pr.title}" (${pr.url}):`}
          placeholder={`Ask about PR #${pr.number}…`}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function repoLabel(s: InfoSession): string | null {
  if ("repo_full_name" in s && s.repo_full_name) {
    const slash = s.repo_full_name.lastIndexOf("/");
    return slash >= 0 ? s.repo_full_name.slice(slash + 1) : s.repo_full_name;
  }
  const parts = s.project.split(/[-/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

interface StatusInfo {
  text: string;
  isLive: boolean;
}

function sessionStatus(s: InfoSession): StatusInfo | null {
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
      return s.lastTs ? { text: `paused ${relativeTime(s.lastTs)}`, isLive: false } : null;
    case SessionState.ENDED:
      return s.lastTs ? { text: `ended ${relativeTime(s.lastTs)}`, isLive: false } : null;
    default:
      return null;
  }
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

function fmtTokens(tokens: TokenUsage | undefined): string | null {
  if (!tokens) return null;
  const total = tokens.in + tokens.out + tokens.cacheWrite + tokens.reasoning;
  if (total <= 0) return null;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${total}`;
}

function ProviderIcon({ source }: { source: EventSource }): JSX.Element {
  const label = source === "codex" ? "OpenAI Codex" : "Claude Code";
  return (
    <span className="shrink-0 text-subtle" title={label} aria-label={label}>
      {source === "codex" ? <OpenAIIcon /> : <ClaudeIcon />}
    </span>
  );
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

function PrIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}
