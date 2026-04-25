# exec-plans/

Sequenced work — sprint plans, audits, trackers. How and when the team executes against the harness rollout.

For the authoring rules, see [`../CONVENTIONS.md`](../CONVENTIONS.md). For the page shape, see [`../templates/plan.md`](../templates/plan.md).

## What's here

| File | Type | Purpose |
| --- | --- | --- |
| [`tech-debt-tracker.md`](tech-debt-tracker.md) | Tracker (perpetual) | Backlog of known gaps + harness-readiness sprint priorities. Append-only-ish; items get ✅ and a code reference when shipped. |
| [`harness-readiness-audit-2026-04-25.md`](harness-readiness-audit-2026-04-25.md) | Dated audit | External harness-readiness audit snapshot. Frozen — never retroactively edited. |
| [`active/`](active/) | Subdirectory | Plans currently in flight. Empty when no plan is actively driving work. |
| [`completed/`](completed/) | Subdirectory | Archived plans from past sprints. Move plans here when the goal has been verified, not when the last item is checked off. |

## Conventions

- **Naming.** Perpetual trackers use `<topic>-tracker.md`. Dated plans and audits use `<name>-YYYY-MM-DD.md`. Other plans use `<name>.md`.
- **Active vs root.** A plan that is actively driving work belongs in `active/`. A plan whose items are tracked in `tech-debt-tracker.md` instead can live at this directory's root.
- **Completion.** Move a plan to `completed/` only after the plan's stated **Goal** has been verified — not when the last item is checked off. The check is "does the goal hold in production?", not "did we run all the steps?".
- **Trackers stay put.** `tech-debt-tracker.md` does not move to `completed/`. Trackers are perpetual; they evolve, they don't finish.

## Adding a new plan

1. Copy [`../templates/plan.md`](../templates/plan.md).
2. Place the new file at `active/<name>.md` (or here at the root if it's a one-shot dated audit).
3. Link from [`../README.md`](../README.md) if the plan is significant enough that an outsider should find it from the docs index.
4. When the plan is complete, move it to `completed/` and update any incoming links.

## See also

- [`../CONVENTIONS.md`](../CONVENTIONS.md) — authoring rules.
- [`../templates/plan.md`](../templates/plan.md) — page shape.
- [`tech-debt-tracker.md`](tech-debt-tracker.md) — the canonical perpetual tracker.
