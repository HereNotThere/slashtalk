import { Fragment, useState, type MouseEvent } from "react";
import {
  BoltIcon,
  ChatBubbleLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FolderIcon,
} from "@heroicons/react/24/outline";
import { SessionState } from "@slashtalk/shared";
import type { EventSource, TokenUsage, UserPr } from "@slashtalk/shared";
import type { InfoDashboardData, InfoSession } from "../../shared/types";
import { ClaudeIcon, OpenAIIcon } from "../shared/icons";
import { Markdown } from "../shared/Markdown";
import { PrItem } from "../shared/PrItem";
import { PrLinkProvider } from "../shared/PrLinkContext";
import { SectionLabel } from "../shared/SectionLabel";
import { ShimmerText } from "../shared/ShimmerText";
import { relativeTime } from "../shared/relativeTime";
import { AskInput } from "./AskInline";

const NOW_WINDOW_MS = 2 * 60 * 60 * 1000; // last 2 hours

export function HierarchyDashboard({
  sessions,
  dashboard,
  dashboardFetching,
  subjectLabel,
}: {
  sessions: InfoSession[] | null;
  dashboard: InfoDashboardData | null;
  /** True between fetch-start and fetch-settle on main. Drives the
   *  shimmering "Fetching…" placeholder so an in-flight refresh isn't
   *  misread as "loaded but empty". */
  dashboardFetching: boolean;
  /** Possessive used in ask-a-question context labels — "my" for self,
   *  "<login>'s" for peers. Threaded through so the prompt shipped to
   *  /api/chat/ask reads naturally regardless of whose card is open. */
  subjectLabel: string;
}): JSX.Element {
  const nowSession = pickNowSession(sessions);
  // Self-mode: server tells us when the user has no claimed user_repos. In
  // that state, every section below would be blank and confusing — surface a
  // single CTA pointing at the main window where repos are picked.
  if (dashboard?.noClaimedRepos) {
    return (
      <>
        <Divider />
        <NoRepoSection />
      </>
    );
  }
  return (
    <>
      <Divider />
      {nowSession && (
        <>
          <NowSection session={nowSession} subjectLabel={subjectLabel} />
          <Divider />
        </>
      )}
      <PastDaySection
        summary={dashboard?.standup ?? null}
        // `loading` only drives the shimmer when there's no summary to show.
        // PastDaySection prefers a stale summary over the shimmer so a
        // background refetch doesn't hide the prior blurb (SWR — see
        // docs/info-card.md).
        loading={dashboard === null || dashboardFetching}
        subjectLabel={subjectLabel}
        prs={dashboard?.prs ?? []}
      />
      <Divider />
      <PrsSection prs={dashboard?.prs ?? null} ghStatus={dashboard?.ghStatus ?? null} />
    </>
  );
}

function NoRepoSection(): JSX.Element {
  return (
    <div className="px-4 py-3">
      <p className="text-sm text-fg/90 leading-snug">No repos connected yet.</p>
      <p className="mt-1 text-xs text-subtle leading-snug">
        Connect a repo from the tray menu to see your standup and PRs here.
      </p>
    </div>
  );
}

function Divider(): JSX.Element {
  return <div className="mx-4 h-px bg-divider" />;
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

function NowSection({
  session,
  subjectLabel,
}: {
  session: InfoSession;
  subjectLabel: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const status = sessionStatus(session);
  const repo = repoLabel(session);
  const tokens = fmtTokens(session.tokens);
  // Only show the analyzer's one-sentence description. Never fall back to the
  // raw user prompt — surfacing what someone literally typed into Claude Code
  // verbatim feels surveillance-y, especially on peer cards.
  const summary = session.description ?? null;
  const title = session.title ?? "Untitled session";
  return (
    <div>
      <div className="px-4 pt-3 pb-1.5 flex items-center gap-1.5">
        <BoltIcon className="w-3.5 h-3.5 shrink-0 text-info" aria-hidden />
        <SectionLabel>Now</SectionLabel>
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <p className="text-sm leading-snug">
              {summary ? (
                <span className="text-fg">{summary}</span>
              ) : (
                <span className="text-subtle italic">Summarizing…</span>
              )}
            </p>
            {(repo || tokens || status) && (
              <div className={`mt-1 flex items-center gap-2 text-[11px] text-subtle min-w-0`}>
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
            contextLabel={`About ${subjectLabel} current session "${title}"${repo ? ` in ${repo}` : ""}:`}
            placeholder="Ask about this session…"
            onClose={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}

function PastDaySection({
  summary,
  loading,
  subjectLabel,
  prs,
}: {
  summary: string | null;
  loading: boolean;
  subjectLabel: string;
  prs: UserPr[];
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <div className="px-4 pt-3 pb-1.5 flex items-center gap-1.5">
        <ClockIcon className="w-3.5 h-3.5 shrink-0 text-muted" aria-hidden />
        <SectionLabel>PAST 24H</SectionLabel>
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 text-sm text-fg/90 leading-snug">
            {summary ? (
              // Block mode (not inline) so bullet lists render as `<ul>` —
              // inline mode wraps everything in a `<span>`, where lists
              // would be invalid HTML and browsers'd unparent them.
              // PrLinkProvider enriches PR links into icon + colored #N.
              <PrLinkProvider prs={prs}>
                <Markdown className="text-sm leading-snug">{summary}</Markdown>
              </PrLinkProvider>
            ) : loading ? (
              <span className="text-subtle">
                <ShimmerText text="Fetching…" />
              </span>
            ) : (
              <span className="text-subtle">Nothing shipped in the past 24h.</span>
            )}
          </div>
          <AskTrigger onClick={() => setEditing(true)} className="-mb-0.5 -mr-1" />
        </div>
        {editing && (
          <AskInput
            contextLabel={`About ${subjectLabel} day so far:`}
            placeholder="Ask about the past 24h…"
            onClose={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}

function PrsSection({
  prs,
  ghStatus,
}: {
  prs: UserPr[] | null;
  ghStatus: InfoDashboardData["ghStatus"] | null;
}): JSX.Element {
  // Default collapsed so the card opens compact — PRs are the longest
  // section and most peeks at a card don't need them. The count in the
  // header tells you whether expanding is worth a click.
  const [open, setOpen] = useState(false);
  const count = prs?.length ?? null;
  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="w-full px-4 pt-3 pb-1.5 flex items-center gap-1.5 text-left hover:bg-surface-alt/40 transition-colors cursor-pointer"
      >
        <ChevronRightIcon
          className={`w-3 h-3 shrink-0 text-subtle transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <SectionLabel>PRs pushed</SectionLabel>
        {count != null && count > 0 && (
          <span className="text-[10px] tracking-wider uppercase text-muted/80">· {count}</span>
        )}
      </button>
      {open &&
        (prs === null ? (
          <div className="px-4 py-2.5 text-xs text-subtle">Loading…</div>
        ) : ghStatus && ghStatus !== "ready" ? (
          <GhUnavailableNudge status={ghStatus} />
        ) : prs.length === 0 ? (
          <div className="px-4 py-2.5 text-xs text-subtle">No PRs in this window.</div>
        ) : (
          prs.map((pr, i) => (
            <Fragment key={`${pr.repoFullName}#${pr.number}`}>
              {i > 0 && <div className="mx-4 h-px bg-divider/60" />}
              <PrRow pr={pr} />
            </Fragment>
          ))
        ))}
    </div>
  );
}

function GhUnavailableNudge({
  status,
}: {
  status: Exclude<InfoDashboardData["ghStatus"], "ready">;
}): JSX.Element {
  // Single-line, copy-pasteable. `brew install gh` covers the common macOS
  // path; users on other package managers will adapt. After install, `gh
  // auth login` is interactive and prints the device-flow URL itself.
  const command = status === "missing" ? "brew install gh && gh auth login" : "gh auth login";
  const headline =
    status === "missing"
      ? "Install the GitHub CLI to see PRs here."
      : "Sign in to the GitHub CLI to see PRs here.";
  const copy = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    void window.chatheads.copyText(command);
  };
  return (
    <div className="px-4 py-2.5">
      <p className="text-xs text-subtle leading-snug">{headline}</p>
      <button
        type="button"
        onClick={copy}
        className="mt-1.5 inline-block w-full text-left px-2 py-1.5 rounded bg-surface-alt/60 hover:bg-surface-alt font-mono text-[11px] text-fg/90 cursor-pointer transition-colors"
        title="Copy command"
      >
        {command}
      </button>
    </div>
  );
}

function PrRow({ pr }: { pr: UserPr }): JSX.Element {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <PrItem
        pr={pr}
        trailing={<AskTrigger onClick={() => setEditing(true)} className="-mr-1" />}
      />
      {editing && (
        <div className="px-4 pb-2">
          <AskInput
            contextLabel={`About PR #${pr.number} — "${pr.title}" (${pr.url}):`}
            placeholder={`Ask about PR #${pr.number}…`}
            onClose={() => setEditing(false)}
          />
        </div>
      )}
    </>
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
  return <ShimmerText text="working now..." />;
}
