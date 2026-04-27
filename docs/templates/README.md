# Doc templates

Page shapes for every doc type in this repo. The third vertex of the convention-template-protocol triangle (see [`../CONVENTIONS.md`](../CONVENTIONS.md#the-convention-template-protocol-triangle)).

## How to use

1. Pick the template that matches what you're writing.
2. Copy it to the right location (see table below).
3. Rename the file per the naming convention in [`../CONVENTIONS.md#naming`](../CONVENTIONS.md#naming).
4. Replace every `<placeholder>` and delete the comment blocks at the top.
5. Link the new doc from its parent index (`docs/README.md`, `design-docs/index.md`, or whichever applies).

## The templates

| Template                         | Use for                                                                                                                                 | Place in                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`design-doc.md`](design-doc.md) | Topic-level durable architectural decision. One decision per doc. Captures Why + alternatives + how to apply.                           | `docs/design-docs/<topic>.md`                                                  |
| [`adr.md`](adr.md)               | Single architectural decision with the trail of alternatives worth preserving. Lighter than a design doc; append-only, never rewritten. | `docs/decisions/<NNNN>-<slug>.md`                                              |
| [`runbook.md`](runbook.md)       | Operational recovery procedure. "When X breaks, do Y."                                                                                  | `docs/runbooks/<topic>.md`                                                     |
| [`spec.md`](spec.md)             | Public surface contract — endpoints, payload formats, protocol semantics.                                                               | `docs/product-specs/<name>.md`                                                 |
| [`plan.md`](plan.md)             | Sequenced work — sprint, audit, tracker.                                                                                                | `docs/exec-plans/<name>.md` (or `<name>-YYYY-MM-DD.md` for dated plans/audits) |

## What a template is not

A template is a _shape_, not a _quota_. Don't pad sections to fill the template — delete sections that don't apply. The shape is there so an agent reading the doc knows where to look; an empty section is worse than a missing one.

A template also isn't a substitute for the rule. The rule lives in [`../CONVENTIONS.md`](../CONVENTIONS.md). Read that first; the template just gives you the page geometry once you know what you're writing.
