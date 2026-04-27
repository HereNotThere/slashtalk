<!--
Template: design doc — topic-level architectural decision.
Place this file at: docs/design-docs/<topic>.md (kebab-case).
Replace every <placeholder>. Delete this comment block before committing.
After writing, link the new doc from docs/design-docs/index.md.
If the decision is load-bearing (future work must respect it), also add a
one-line entry in docs/design-docs/core-beliefs.md so it surfaces in
Tier-3 enforcement scans.
-->

# <Decision title in noun phrase form, e.g., "Route prefix encodes auth">

<One paragraph of context: what was the situation prompting this decision, what problem does it solve, why now. Should answer "why are we writing this down?" in 3-5 sentences.>

## Decision

<The decision itself, stated plainly. 1-3 paragraphs. Use imperative voice — "We use X for Y" rather than "We propose to use X.">

## Why

<The reasoning. What property of the system does this decision protect? What goes wrong without it? Reference any prior incident or constraint that motivated the choice.>

## How to apply

<Concrete instructions. Where in the codebase does this rule bite? What files are affected? What's the exact contract a new contributor must respect?>

- <Step or invariant 1>
- <Step or invariant 2>
- <Step or invariant 3>

## Alternatives considered

- **<Alternative 1>** — <why rejected, in 1-2 sentences>
- **<Alternative 2>** — <why rejected>
- **<Alternative 3>** — <why rejected, if applicable>

## See also

- [`<related-doc>`](path) — <why related>
- [`core-beliefs #<N>`](core-beliefs.md#<anchor>) — <if this design-doc has a corresponding numbered rule>
