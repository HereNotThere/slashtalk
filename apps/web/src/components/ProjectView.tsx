import { Fragment, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type {
  ProjectActivePerson,
  ProjectBucket,
  ProjectOverviewResponse,
  ProjectPr,
} from "@slashtalk/shared";
import { AuthError, fetchRepoOverview } from "../lib/api";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { PrRow } from "./PrRow";

interface ProjectViewProps {
  repoFullName: string;
  visibleRepos: string[];
  onPickRepo: (repo: string) => void;
  onPickPerson: (login: string) => void;
  onAuthError: () => void;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; overview: ProjectOverviewResponse }
  | { kind: "error"; message: string };

export function ProjectView({
  repoFullName,
  visibleRepos,
  onPickRepo,
  onPickPerson,
  onAuthError,
}: ProjectViewProps): JSX.Element {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchRepoOverview(repoFullName)
      .then((overview) => {
        if (!cancelled) setState({ kind: "ready", overview });
      })
      .catch((err) => {
        if (err instanceof AuthError) {
          if (!cancelled) onAuthError();
          return;
        }
        if (!cancelled) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repoFullName, onAuthError]);

  const overview = state.kind === "ready" ? state.overview : null;
  const active = overview?.active ?? [];
  const buckets = overview?.buckets ?? [];
  const prsByNumber = new Map<number, ProjectPr>((overview?.prs ?? []).map((p) => [p.number, p]));

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-divider bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-fg hover:bg-surface-alt/40"
          aria-expanded={pickerOpen}
        >
          <span className="truncate font-mono text-sm font-bold">{repoFullName}</span>
          {visibleRepos.length > 1 ? (
            <ChevronDownIcon
              className={`h-3.5 w-3.5 flex-none text-subtle transition-transform ${pickerOpen ? "rotate-180" : ""}`}
            />
          ) : null}
        </button>
        {active.length > 0 ? (
          <span className="text-xs text-subtle">{active.length} active</span>
        ) : null}
      </header>

      {pickerOpen && visibleRepos.length > 1 ? (
        <div className="border-b border-divider bg-surface-alt/40">
          <ul className="m-0 max-h-60 list-none divide-y divide-divider/60 overflow-y-auto p-0">
            {visibleRepos.map((r) => (
              <li key={r}>
                <button
                  type="button"
                  className={`block w-full px-4 py-2.5 text-left text-sm font-mono ${r === repoFullName ? "text-primary" : "text-fg hover:bg-surface-alt/60"}`}
                  onClick={() => {
                    setPickerOpen(false);
                    if (r !== repoFullName) onPickRepo(r);
                  }}
                >
                  {r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        <article className="mx-3 my-3 overflow-hidden rounded-xl border border-divider bg-surface">
          {active.length > 0 ? (
            <>
              <ActiveStrip people={active} onPickPerson={onPickPerson} />
              <Divider />
            </>
          ) : null}

          <PulseSection pulse={overview?.pulse ?? null} loading={state.kind === "loading"} />

          {buckets.length > 0 ? <Divider /> : null}
          {buckets.map((b, i) => (
            <Fragment key={`${b.name}-${i}`}>
              {i > 0 ? <div className="mx-4 h-px bg-divider/60" /> : null}
              <BucketRow bucket={b} prsByNumber={prsByNumber} />
            </Fragment>
          ))}

          {state.kind === "error" ? (
            <div className="px-4 py-4 text-sm text-subtle">
              Could not load project overview ({state.message}).
            </div>
          ) : null}
        </article>
      </div>
    </div>
  );
}

function Divider(): JSX.Element {
  return <div className="mx-4 h-px bg-divider" />;
}

function PulseSection({ pulse, loading }: { pulse: string | null; loading: boolean }): JSX.Element {
  return (
    <div className="px-4 pb-3 pt-4 text-sm leading-snug text-fg">
      {pulse ? (
        <Markdown>{pulse}</Markdown>
      ) : loading ? (
        <span className="text-subtle">Reading the room…</span>
      ) : (
        <span className="text-subtle">Quiet window — no PRs in flight.</span>
      )}
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
  // PWA defaults buckets to expanded — the desktop card lives inside a small
  // popover and benefits from the collapsed default, but the PWA has full
  // viewport height and showing the PRs directly is more useful.
  const [open, setOpen] = useState(true);
  const prs = bucket.prNumbers
    .map((n) => prsByNumber.get(n))
    .filter((p): p is ProjectPr => Boolean(p));
  const authors = new Set(prs.map((p) => p.authorLogin));
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-alt/40"
        aria-expanded={open}
      >
        <ChevronRightIcon
          className={`h-3.5 w-3.5 flex-none text-subtle transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="flex-1 truncate text-sm text-fg">{bucket.name}</span>
        <span className="flex-none text-xs text-subtle">
          {prs.length} PR{prs.length === 1 ? "" : "s"} · {authors.size} author
          {authors.size === 1 ? "" : "s"}
        </span>
      </button>
      {open ? (
        <div className="px-4 pb-2">
          {prs.map((pr) => (
            <PrRow
              key={`${pr.number}`}
              hideRepo
              pr={{
                number: pr.number,
                title: pr.title,
                url: pr.url,
                repoFullName: "",
                state: pr.state,
                updatedAt: pr.updatedAt,
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActiveStrip({
  people,
  onPickPerson,
}: {
  people: ProjectActivePerson[];
  onPickPerson: (login: string) => void;
}): JSX.Element {
  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-subtle">Active</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {people.map((p) => (
          <button
            key={p.login}
            type="button"
            onClick={() => onPickPerson(p.login)}
            title={p.login}
            aria-label={`Open card for ${p.login}`}
            className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <Avatar src={p.avatarUrl} login={p.login} size={28} />
          </button>
        ))}
      </div>
    </div>
  );
}
