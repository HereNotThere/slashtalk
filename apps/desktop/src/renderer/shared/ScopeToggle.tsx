import type { MouseEvent } from "react";
import type { DashboardScope } from "../../shared/types";

const OPTS: { scope: DashboardScope; label: string }[] = [
  { scope: "today", label: "Today" },
  { scope: "past24h", label: "24h" },
];

/** Two text labels in the same uppercase mini-cap font as the section
 *  headers; the inactive one is dimmed. State is global (see
 *  useDashboardScope) so flipping in one card flips every other open
 *  surface. */
export function ScopeToggle({
  scope,
  onChange,
}: {
  scope: DashboardScope;
  onChange: (next: DashboardScope) => void;
}): JSX.Element {
  const click = (e: MouseEvent<HTMLButtonElement>, next: DashboardScope): void => {
    e.stopPropagation();
    if (next !== scope) onChange(next);
  };
  return (
    <div className="flex items-center gap-1.5">
      {OPTS.map((o) => {
        const active = scope === o.scope;
        return (
          <button
            key={o.scope}
            type="button"
            onClick={(e) => click(e, o.scope)}
            aria-pressed={active}
            className={`text-xs font-semibold tracking-wider uppercase bg-transparent border-none p-0 [font:inherit] transition-colors ${
              active
                ? "text-subtle cursor-default"
                : "text-muted/50 hover:text-muted cursor-pointer"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
