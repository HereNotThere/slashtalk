# docs/

The system of record for slashtalk. Every durable decision, spec, plan, and reference lives here. Maps live at the repo root ([`AGENTS.md`](../AGENTS.md), [`CLAUDE.md`](../CLAUDE.md), [`ARCHITECTURE.md`](../ARCHITECTURE.md)); deep content lives here.

To author a doc, read [`CONVENTIONS.md`](CONVENTIONS.md) for the rules and copy a shape from [`templates/`](templates/).

## Two-tier structure

`docs/` has two intentional tiers (see [`CONVENTIONS.md#the-two-tier-docs-hierarchy`](CONVENTIONS.md#the-two-tier-docs-hierarchy)):

1. **Top-level cross-cutting specs** — UPPERCASE filenames at `docs/` root, treated like LICENSE / SECURITY / CONTRIBUTING. Always-load tier.
2. **Topic-level docs in subdirectories** — kebab-case files under `docs/<subdir>/`. Indexed by this README and by per-subdirectory READMEs where they exist.

Both tiers are canonical. Placement signals scope, not authority.

## Top-level cross-cutting docs

| Doc                                    | Purpose                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`CONVENTIONS.md`](CONVENTIONS.md)     | The authoring bible — every doc type, where it lives, naming, when to write what. Read this before adding any doc.                      |
| [`RELIABILITY.md`](RELIABILITY.md)     | How load-bearing flows (ingest, heartbeat, pub/sub, analyzers) degrade and recover. Resume protocol, state machine, soft-fail contract. |
| [`SECURITY.md`](SECURITY.md)           | Threat model, OAuth scope, repo-claim verification, token storage and hashing, JWT cookie, PII surface, secrets in WS payloads.         |
| [`QUALITY_SCORE.md`](QUALITY_SCORE.md) | Per-domain health grades. Tests / docs / invariants / open gaps for every server domain, desktop subsystem, and shared package.         |

## Subdirectories

| Subdir                             | What's there                                                                                                                                                   | Index                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [`design-docs/`](design-docs/)     | Topic-level durable architectural decisions. One topic per doc. Plus [`core-beliefs.md`](design-docs/core-beliefs.md) — the load-bearing rules with Why + How. | [`design-docs/index.md`](design-docs/index.md) |
| [`product-specs/`](product-specs/) | Public surface contracts: backend API, ingest protocol, WS message shapes, web PWA scope. What we ship.                                                        | (no index yet — see contents)                  |
| [`exec-plans/`](exec-plans/)       | Sprint plans, audits, trackers — how and when we work. Active and dated plans.                                                                                 | [`exec-plans/README.md`](exec-plans/README.md) |
| [`manual-tests/`](manual-tests/)   | Human verification runbooks for flows that require installed apps, OAuth handoffs, releases, or external clients.                                              | (no index yet — see contents)                  |
| [`generated/`](generated/)         | Auto-derived from code (e.g., DB schema). Never hand-edit.                                                                                                     | (single file: `db-schema.md`)                  |
| [`references/`](references/)       | Third-party library notes in [llms.txt format](https://llmstxt.org). One `.txt` per library.                                                                   | [`references/README.md`](references/README.md) |
| [`templates/`](templates/)         | Page shapes for every doc type. Copy-and-fill starting points.                                                                                                 | [`templates/README.md`](templates/README.md)   |
| `decisions/` _(planned)_           | ADRs — append-only architecture decision records with `NNNN-slug.md` numbering.                                                                                | —                                              |
| `runbooks/` _(planned)_            | Operational recovery procedures. Created on the second occurrence of a failure mode.                                                                           | —                                              |

## How to find what you need

| You want to …                                         | Read                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Understand the project's domains end to end           | [`../ARCHITECTURE.md`](../ARCHITECTURE.md)                                                                   |
| Add a route, analyzer, table, window, or shared type  | [`../AGENTS.md`](../AGENTS.md) → per-workspace `AGENTS.md`                                                   |
| Know which rules can't be broken                      | [`design-docs/core-beliefs.md`](design-docs/core-beliefs.md)                                                 |
| Know which load-bearing memories to honor             | [`../CLAUDE.md`](../CLAUDE.md)                                                                               |
| Understand auth, encryption, PII                      | [`SECURITY.md`](SECURITY.md)                                                                                 |
| Understand ingest resume, heartbeat states, soft-fail | [`RELIABILITY.md`](RELIABILITY.md)                                                                           |
| Look up the DB schema                                 | [`generated/db-schema.md`](generated/db-schema.md)                                                           |
| Understand the backend or upload contract             | [`product-specs/backend.md`](product-specs/backend.md), [`product-specs/upload.md`](product-specs/upload.md) |
| See known gaps and the harness rollout plan           | [`exec-plans/tech-debt-tracker.md`](exec-plans/tech-debt-tracker.md)                                         |
| Look up a third-party library's gotchas               | [`references/`](references/)                                                                                 |
| Author a new doc                                      | [`CONVENTIONS.md`](CONVENTIONS.md) + [`templates/`](templates/)                                              |

## How docs change

When code changes, the docs that describe that code change in the same commit. A subtly wrong map is worse than a missing one. The full rule set lives in [`CONVENTIONS.md#keeping-docs-current`](CONVENTIONS.md#keeping-docs-current).
