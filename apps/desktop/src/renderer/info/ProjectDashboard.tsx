import { Fragment, useState } from "react";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import {
  shortRepoName,
  type ProjectActivePerson,
  type ProjectBucket,
  type ProjectOverviewResponse,
  type ProjectPr,
} from "@slashtalk/shared";
import { Markdown } from "../shared/Markdown";
import { PersonAvatar } from "../shared/PersonAvatar";
import { PrItem } from "../shared/PrItem";
import { ScopeToggle } from "../shared/ScopeToggle";
import { ShimmerText } from "../shared/ShimmerText";
import { useDashboardScope } from "../shared/useDashboardScope";
import { AskInput } from "./AskInline";

export function ProjectDashboard({
  repoFullName,
  overview,
  fetching,
}: {
  repoFullName: string;
  overview: ProjectOverviewResponse | null;
  /** True between fetch-start and fetch-settle on main. Drives the shimmer
   *  on the pulse line so an in-flight refresh isn't misread as empty. */
  fetching: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const prsByNumber = new Map<number, ProjectPr>((overview?.prs ?? []).map((p) => [p.number, p]));
  const buckets = overview?.buckets ?? [];
  const active = overview?.active ?? [];

  return (
    <div>
      <ProjectHeader repoFullName={repoFullName} activeCount={active.length} />
      <Divider />
      <PulseSection pulse={overview?.pulse ?? null} loading={fetching} />
      {buckets.length > 0 && <Divider />}
      {buckets.map((b, i) => (
        <Fragment key={`${b.name}-${i}`}>
          {i > 0 && <div className="mx-4 h-px bg-divider/60" />}
          <BucketRow bucket={b} prsByNumber={prsByNumber} />
        </Fragment>
      ))}
      {active.length > 0 && <Divider />}
      {active.length > 0 && <ActiveStrip people={active} />}
      <div className="px-4 pb-3 pt-2">
        {editing ? (
          <AskInput
            contextLabel={`About the project ${repoFullName}:`}
            placeholder={`Ask about ${shortRepoName(repoFullName)}…`}
            onClose={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="w-full h-9 px-3.5 rounded-full bg-surface-alt border border-divider text-left text-sm text-subtle hover:bg-surface-alt-hover transition-colors cursor-pointer"
          >
            Ask about {shortRepoName(repoFullName)}…
          </button>
        )}
        <FeedbackLink />
      </div>
    </div>
  );
}

function FeedbackLink(): JSX.Element {
  // mailto in Electron must go through openExternal — plain `<a href>` is
  // either ignored or routed inside the BrowserWindow.
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void window.chatheads.openExternal("mailto:info@hntlabs.com");
      }}
      className="mt-2 block w-full text-center text-[11px] text-subtle hover:text-fg transition-colors cursor-pointer"
    >
      Click here to send feedback
    </button>
  );
}

function Divider(): JSX.Element {
  return <div className="mx-4 h-px bg-divider" />;
}

function ProjectHeader({
  repoFullName,
  activeCount,
}: {
  repoFullName: string;
  activeCount: number;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-4 pt-4 pb-3">
      <div className="text-lg font-bold leading-tight truncate font-mono">{repoFullName}</div>
      {activeCount > 0 && (
        <div className="ml-auto text-[11px] text-subtle shrink-0">{activeCount} active</div>
      )}
    </div>
  );
}

function PulseSection({ pulse, loading }: { pulse: string | null; loading: boolean }): JSX.Element {
  const { scope, setScope } = useDashboardScope();
  return (
    <div>
      <div className="px-4 pt-3 pb-1.5">
        <ScopeToggle scope={scope} onChange={setScope} />
      </div>
      <div className="px-4 pb-3 text-sm text-fg/90 leading-snug">
        {pulse ? (
          <Markdown inline className="text-sm leading-snug">
            {pulse}
          </Markdown>
        ) : loading ? (
          <span className="text-subtle">
            <ShimmerText text="Reading the room…" />
          </span>
        ) : (
          <span className="text-subtle">Quiet window — no PRs in flight.</span>
        )}
      </div>
    </div>
  );
}

function BucketRow({
  bucket,
  prsByNumber,
}: {
  bucket: ProjectBucket;
  prsByNumber: Map<number, ProjectPr>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const prs = bucket.prNumbers
    .map((n) => prsByNumber.get(n))
    .filter((p): p is ProjectPr => Boolean(p));
  // Distinct authors in this bucket — surfaced as a people-count chip beside
  // the bucket name so the collapsed row hints at "who" without expanding.
  const authors = new Set(prs.map((p) => p.authorLogin));
  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-surface-alt/60 transition-colors cursor-pointer text-left"
        aria-expanded={open}
      >
        <ChevronRightIcon
          className={`w-3.5 h-3.5 shrink-0 text-subtle transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span className="text-sm text-fg flex-1 truncate">{bucket.name}</span>
        <span className="text-[11px] text-subtle shrink-0">
          {prs.length} PR{prs.length === 1 ? "" : "s"} · {authors.size} author
          {authors.size === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="pb-1.5">
          {prs.map((pr, i) => (
            <Fragment key={`${pr.number}-${i}`}>
              {i > 0 && <div className="mx-6 h-px bg-divider/40" />}
              <PrRow pr={pr} />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function PrRow({ pr }: { pr: ProjectPr }): JSX.Element {
  return (
    <PrItem
      pr={pr}
      authorLogin={pr.authorLogin}
      trailing={
        <PersonAvatar person={{ login: pr.authorLogin, avatarUrl: pr.authorAvatarUrl }} size={20} />
      }
    />
  );
}

function ActiveStrip({ people }: { people: ProjectActivePerson[] }): JSX.Element {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] font-semibold tracking-wider uppercase text-subtle mb-2">
        Active
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {people.map((p) => (
          <PersonChip key={p.login} person={p} />
        ))}
      </div>
    </div>
  );
}

function PersonChip({ person }: { person: ProjectActivePerson }): JSX.Element {
  // Click → ask main to swap the popover to that person's card. Pass the
  // avatar so main can synthesize a head when the target isn't on the rail
  // (active people are user_repos members; the rail is the social-feed
  // subset, which can omit folks who authored a PR without a session).
  const open = (): void => {
    void window.chatheads.showInfo(
      `user:${person.login}`,
      undefined,
      person.avatarUrl ?? undefined,
    );
  };
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      title={person.login}
      aria-label={`Open card for ${person.login}`}
      className="cursor-pointer rounded-full focus:outline-none focus:ring-2 focus:ring-primary/50"
    >
      <PersonAvatar person={person} size={28} />
    </button>
  );
}
