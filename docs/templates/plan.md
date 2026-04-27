<!--
Template: exec plan — sequenced work.
Place this file at: docs/exec-plans/<name>.md, or docs/exec-plans/<name>-YYYY-MM-DD.md
for dated plans (audits, sprint plans, snapshots). For a perpetual tracker
that's append-only-ish, use docs/exec-plans/<name>-tracker.md (see
tech-debt-tracker.md for the canonical example).
Replace every <placeholder>. Delete this comment block before committing.
-->

# <Plan name>

<One paragraph: what we're trying to achieve, by when, why now. The reader should be able to repeat the plan's purpose in one sentence after reading this paragraph.>

## Goal

<The verifiable outcome. "We will know we're done when …">

## Sequencing

<Numbered, ordered work items. Use the same ✅ / strikethrough convention as tech-debt-tracker.md so completed items remain visible as a record.>

| #   | Item   | Owner  | Status  |
| --- | ------ | ------ | ------- |
| 1   | <item> | <name> | pending |
| 2   | <item> | <name> | pending |
| 3   | <item> | <name> | pending |

<Or, for narrative-style plans:>

**Day 1.** <work>

**Day 2.** <work>

**Day 3.** <work>

## Out of scope

<What this plan deliberately is not addressing. Naming the boundary prevents scope creep mid-sprint.>

- <thing 1>
- <thing 2>

## Open questions

<Things the plan raises but does not yet resolve. Each should have a path to resolution — "decide before item N" — rather than sitting forever.>

- <Question 1> — decide before <item or date>.
- <Question 2> — decide before <item or date>.

## See also

- [`<related-plan>`](path) — <why related>
- [`tech-debt-tracker.md`](tech-debt-tracker.md) — if this plan's items also appear there
