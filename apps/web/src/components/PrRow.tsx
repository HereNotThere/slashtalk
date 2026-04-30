import type { UserPr } from "@slashtalk/shared";
import { repoName, timeAgo } from "../lib/format";

const STATE_DOT: Record<UserPr["state"], string> = {
  open: "bg-success",
  merged: "bg-merged",
  closed: "bg-danger",
};

const STATE_LABEL: Record<UserPr["state"], string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

interface PrRowProps {
  pr: UserPr;
  /** Suppress the repo-name prefix when the row is rendered inside a card
   *  that already names the repo (e.g. the project view). */
  hideRepo?: boolean;
}

export function PrRow({ pr, hideRepo = false }: PrRowProps): JSX.Element {
  const repoPrefix = hideRepo || !pr.repoFullName ? "" : `${repoName(pr.repoFullName)} `;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="grid grid-cols-[10px_minmax(0,1fr)] gap-x-2 py-2 text-fg no-underline transition-colors hover:bg-surface-alt/40 -mx-2 px-2 rounded"
    >
      <div className={`mt-1.5 h-2 w-2 rounded-full ${STATE_DOT[pr.state]}`} aria-hidden="true" />
      <div className="min-w-0">
        <h3 className="m-0 line-clamp-2 text-sm leading-tight">{pr.title}</h3>
        <p className="m-0 mt-1 text-xs font-semibold text-subtle">
          {repoPrefix}#{pr.number} · {STATE_LABEL[pr.state]} · {timeAgo(pr.updatedAt)}
        </p>
      </div>
    </a>
  );
}
