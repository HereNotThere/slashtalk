import type { MouseEvent } from "react";
import type { DashboardScope } from "../../shared/types";

const OPTS: { scope: DashboardScope; label: string }[] = [
  { scope: "today", label: "Today" },
  { scope: "past24h", label: "24h" },
];

/** Compact segmented toggle for the user/project card headers. Matches the
 *  size of the existing "Xm/Xh" age pills on the rail so it doesn't dominate
 *  the header strip. State is global (see useDashboardScope) so flipping in
 *  one card flips every open surface. */
export function ScopeToggle({
  scope,
  onChange,
}: {
  scope: DashboardScope;
  onChange: (next: DashboardScope) => void;
}): JSX.Element {
  const click = (e: MouseEvent<HTMLButtonElement>, next: DashboardScope): void => {
    // Cards live inside a window that also reacts to clicks (drag, focus).
    // Stop the event from bubbling so toggling doesn't trigger surrounding
    // UX (e.g. AskInput open).
    e.stopPropagation();
    if (next !== scope) onChange(next);
  };
  return (
    <div className="inline-flex rounded bg-surface-alt p-0.5 gap-0.5">
      {OPTS.map((o) => {
        const active = scope === o.scope;
        return (
          <button
            key={o.scope}
            type="button"
            onClick={(e) => click(e, o.scope)}
            aria-pressed={active}
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider uppercase cursor-pointer border-none [font:inherit] ${
              active ? "bg-bg text-fg" : "bg-transparent text-fg/60 hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
