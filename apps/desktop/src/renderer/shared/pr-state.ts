/** Tailwind class mappings for the three PR states. Shared between the
 *  user-card PR rows (`HierarchyDashboard`) and the project-card bucket rows
 *  (`ProjectDashboard`) so they stay in lockstep when a state-color or
 *  label convention shifts. */

type PrState = "open" | "closed" | "merged";

export const PR_STATE_COLOR: Record<PrState, string> = {
  open: "text-success",
  merged: "text-info",
  closed: "text-danger",
};

export const PR_STATE_LABEL: Record<PrState, string> = {
  open: "open",
  merged: "merged",
  closed: "closed",
};
