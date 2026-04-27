<!--
Template: ADR — Architecture Decision Record.
Place this file at: docs/decisions/<NNNN>-<slug>.md
  - <NNNN> = next sequential 4-digit number (0001, 0002, …)
  - <slug> = kebab-case short title
ADRs are append-only. Never rewrite an accepted ADR; if the decision
changes, write a new ADR with `supersedes` set and update the original's
`superseded_by` and `status` fields.
Replace every <placeholder>. Delete this comment block before committing.
-->

---

status: proposed
date: <YYYY-MM-DD>
supersedes: <NNNN-slug or null>
superseded_by: null

---

# <NNNN>. <Decision title>

## Context

<What's the situation prompting this decision? What forces are at play? Keep this to 2-4 sentences. The reader should understand "why now" by the end of this section.>

## Decision

<What we're going to do, stated as a single clear claim. Imperative voice.>

## Consequences

<What becomes easier as a result. What becomes harder. What's now ruled out. Be honest about both sides — an ADR that only lists upsides is incomplete.>

**Easier:**

- <consequence 1>
- <consequence 2>

**Harder:**

- <consequence 1>
- <consequence 2>

**Ruled out:**

- <option that's now off the table>

## Alternatives considered

- **<Alternative 1>** — <one-line description>. <Why rejected.>
- **<Alternative 2>** — <one-line description>. <Why rejected.>
- **<Alternative 3>** — <one-line description>. <Why rejected.>

## References

- <link to design-doc, core-belief, PR, or external source that informs this ADR>
