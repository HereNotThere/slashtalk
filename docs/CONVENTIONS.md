# Docs conventions

This is the authoring bible for slashtalk's documentation. Every agent (Claude Code, Codex, Cursor, …) and every developer adding a doc reads this file first. The goal: an outsider can navigate the repo cold and contribute a doc that fits without guessing at the team's mental model.

For the navigation map, see [`README.md`](README.md). For the page shapes, see [`templates/`](templates/).

## Doc types — where each lives

| Type                   | Location                                                                                  | Purpose                                                                                                                                           | Shape                                                                                              | When to add                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Map**                | `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, per-workspace `AGENTS.md`                    | Tell an agent where to go for everything else. Map-sized, not manual-sized.                                                                       | Free-form, dense links                                                                             | Whenever a workspace, prefix, or major subsystem changes shape                                       |
| **Cross-cutting spec** | `docs/RELIABILITY.md`, `docs/SECURITY.md`, `docs/QUALITY_SCORE.md`                        | Top-level mental models that span multiple domains. UPPERCASE filename signals "treat like LICENSE / SECURITY / CONTRIBUTING — always-load tier." | Free prose with H2 sections per concern                                                            | Rarely. Net-new only when a concern genuinely cuts across all domains                                |
| **Design doc**         | `docs/design-docs/<topic>.md`                                                             | Topic-level durable decision (one decision = one doc). Captures _why_, alternatives rejected, how to apply.                                       | Template: [`templates/design-doc.md`](templates/design-doc.md)                                     | When a non-trivial decision is made that future work must respect                                    |
| **Core belief**        | One numbered entry in `docs/design-docs/core-beliefs.md`                                  | Load-bearing rule with **Why** + **How to apply**. Tier-3 of the harness plan converts each into a mechanical CI check.                           | Inline in the existing file, append-only numbered list                                             | When a design decision is so load-bearing that violating it causes regressions or data loss          |
| **ADR**                | `docs/decisions/<NNNN>-<slug>.md` (planned — see [`templates/adr.md`](templates/adr.md))  | Append-only record of a single architectural decision, including alternatives considered. Lighter-weight than a design doc.                       | Template: [`templates/adr.md`](templates/adr.md)                                                   | When a decision is worth preserving the trail of judgment for, but doesn't warrant a full design doc |
| **Product spec**       | `docs/product-specs/<name>.md`                                                            | What we ship to clients — endpoint shapes, payload formats, protocol semantics.                                                                   | Free prose with concrete request/response examples                                                 | When a public surface (API endpoint, ingest protocol, message shape) is being defined or revised     |
| **Exec plan**          | `docs/exec-plans/<name>.md` (or `active/`, `completed/`)                                  | How and when we work — sprint plans, audits, trackers.                                                                                            | Free prose; trackers use numbered ✅-able items                                                    | When concrete work needs sequencing, tracking, or a verdict                                          |
| **Generated**          | `docs/generated/<name>.md`                                                                | Auto-derived from code. Never hand-edit.                                                                                                          | Whatever the generator emits                                                                       | Never by hand; only via the generator                                                                |
| **Reference**          | `docs/references/<lib>-llms.txt`                                                          | Third-party library notes in [llms.txt format](https://llmstxt.org). Plain text, no frontmatter.                                                  | Title line, version line, "Load-bearing gotchas" section, "Where we use it" section, upstream link | When pinning a new library version or capturing an upstream gotcha                                   |
| **Template**           | `docs/templates/<type>.md`                                                                | Page shape for each doc type. The third vertex of the convention-template-protocol triangle.                                                      | Frontmatter (if any) + required sections                                                           | When a new doc type is added                                                                         |
| **Runbook**            | `docs/runbooks/<topic>.md` (planned — see [`templates/runbook.md`](templates/runbook.md)) | Operational recovery procedures. "When X breaks, do Y."                                                                                           | Template: [`templates/runbook.md`](templates/runbook.md)                                           | When a failure mode is encountered for the second time                                               |

## The two-tier docs hierarchy

`docs/` has two intentional tiers:

1. **Top-level cross-cutting specs** — `docs/RELIABILITY.md`, `docs/SECURITY.md`, `docs/QUALITY_SCORE.md`. UPPERCASE filename, root of `docs/`, treated like LICENSE / SECURITY / CONTRIBUTING. Always-load tier — agents and developers look here before any subdir.
2. **Topic-level docs in subdirectories** — `docs/design-docs/`, `docs/product-specs/`, `docs/exec-plans/`, `docs/generated/`, `docs/references/`, `docs/templates/`. Subdir filename, kebab-case, indexed by `docs/README.md` and (for design-docs) `docs/design-docs/index.md`.

Both tiers are canonical. The placement difference signals scope, not authority. A new top-level cross-cutting doc is rare; the default for a new doc is one of the subdirectories.

## Naming

- **Subdirectory docs:** kebab-case, lowercase, `.md`. Example: `core-beliefs.md`, `tech-debt-tracker.md`, `harness-readiness-audit-2026-04-25.md`.
- **Top-level cross-cutting docs:** UPPERCASE single-word names ending in `.md`. Reserved tier — only three exist today (`RELIABILITY.md`, `SECURITY.md`, `QUALITY_SCORE.md`); adding a fourth requires explicit justification that the doc is genuinely cross-cutting and always-load tier.
- **References:** `<library>-llms.txt` (e.g., `elysia-llms.txt`). The `-llms.txt` suffix is intentional — it follows the [llms.txt format](https://llmstxt.org) and is the third-party-context tier. References are `.txt`, not `.md`.
- **Daily-style or dated docs** (audits, postmortems): suffix with `-YYYY-MM-DD`. Example: `harness-readiness-audit-2026-04-25.md`.
- **ADRs:** `NNNN-<slug>.md` with zero-padded sequential numbers. Example: `0001-route-prefix-encodes-auth.md`.
- **No spaces, no SCREAMING_SNAKE, no PascalCase** anywhere except the three legacy top-level docs above.

## Per-workspace `AGENTS.md`

Every workspace under `apps/*` and `packages/*` has its own `AGENTS.md`. The shape varies by what the workspace is:

- **`apps/server/AGENTS.md`** — recipe-heavy ("Adding a route plugin", "Adding an LLM analyzer", "Adding a database column or table"). Server is where most agent work happens, so the recipes carry their weight.
- **`apps/desktop/AGENTS.md`** — design-system-heavy. Tailwind tokens, theming, packaging quirks. Recipes are thinner because window/IPC additions are rarer.
- **`packages/shared/AGENTS.md`** — constraint-heavy. "No build, no `dist/`, source-only." Negative space matters more than recipes.

This shape variance is **intentional**. Each workspace's AGENTS.md reflects the kind of work that happens there. Don't standardize on a single skeleton — that would be cargo-cult.

**The minimum every workspace AGENTS.md must include:**

1. `## Layout` — directory tree with one-line annotations.
2. `## Commands` — every script the workspace exposes, runnable from the workspace root.
3. `## Before committing` — the exact pre-commit gate for this workspace (typecheck, test, lint as applicable).

Beyond that minimum, each workspace adds whatever sections fit its role. Update the file in the same commit that changes the layout, commands, or pre-commit contract.

## The convention-template-protocol triangle

When you add a new convention to the docs system, it must land in three places:

1. **Convention** — this file. The rule itself.
2. **Template** — `docs/templates/<type>.md`. The shape the convention produces.
3. **Protocol** — wherever the doc type's "when to write" instructions live (`docs/design-docs/index.md` for design docs, this file's "Doc types" table for the rest).

Missing any vertex means an agent following a different entry point won't know the convention exists. When you change a convention, do all three in the same commit. (This rule is itself a convention from the wiki schema, captured 2026-04-16; it has earned its place by catching three convention-drift bugs in one review.)

## Authoring rules

### Rewrite, don't append

When new information would update an existing doc, **rewrite the doc to integrate the new information**. Don't tack on a "## 2026-04-25 update" subsection. The exceptions: append-only sections explicitly named as such (ADRs, `core-beliefs.md` numbered list, `log.md`-style trackers).

### Anti-cramming

If you find yourself writing a third paragraph about a sub-topic in an existing doc, that sub-topic deserves its own doc. Split it into a new design-doc and link from the original.

### Anti-thinning

If you can't write at least three meaningful paragraphs about the topic, don't create the doc yet. Empty or stub docs are worse than no doc — they signal a structure that doesn't carry weight. The same rule applies to subdirectories: don't create an empty subdirectory with a `.gitkeep` unless the subdirectory's purpose is explicitly documented in a `README.md` alongside it.

### Decision capture

When a non-trivial decision is made — choosing one approach over another, forming a position, changing direction — record it. Choose the smallest correct artifact:

- **Code-level invariant** → numbered entry in `core-beliefs.md` with **Why** + **How to apply**.
- **Topic-level architectural decision** → new `docs/design-docs/<topic>.md`.
- **Single architectural choice with alternatives worth preserving** → new `docs/decisions/<NNNN>-<slug>.md` (ADR).
- **Sprint or audit verdict** → `docs/exec-plans/<name>-YYYY-MM-DD.md`.

The trail of judgment is the point — not just the conclusion.

### Frontmatter

Most docs in this repo do not use YAML frontmatter today. ADRs ([`templates/adr.md`](templates/adr.md)) are the exception — they use frontmatter to encode `status` and `date`. Other doc types stay frontmatter-free unless a future tool requires it.

### Linking

- Use plain markdown links: `[label](relative/path.md)`.
- Prefer relative paths from the linking doc.
- When linking to a numbered `core-beliefs.md` rule, link to the kebab-case anchor: `[core-beliefs #2](design-docs/core-beliefs.md#2-route-prefix-encodes-auth)`.
- When the same target is linked from many places (e.g., `core-beliefs.md`), it's fine for the link to be repeated — agents follow links per-doc, not globally.

## Keeping docs current

The single load-bearing rule across all docs: **a subtly wrong map is worse than a missing one.** When you change code, the docs that describe that code must change in the same commit:

- New workspace, prefix, or auth scheme → root [`AGENTS.md`](../AGENTS.md) + [`ARCHITECTURE.md`](../ARCHITECTURE.md).
- New BrowserWindow, IPC channel, or analyzer plugin contract → relevant per-workspace `AGENTS.md`.
- New `core-beliefs.md` rule → also surface in [`CLAUDE.md`](../CLAUDE.md) "Load-bearing memories" if violations would cause regressions.
- New library version or upstream gotcha → `docs/references/<lib>-llms.txt`.
- Schema change → `bun run gen:db-schema` regenerates `docs/generated/db-schema.md`. CI checks freshness.

## The Tier 1–5 harness plan

The team has a named rollout plan for hardening the harness over time. References to "Tier N" across `CLAUDE.md`, `core-beliefs.md`, `QUALITY_SCORE.md`, and `tech-debt-tracker.md` follow this scheme:

| Tier       | What lands                                                                                                                   | Status                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Tier 1** | Doc scaffolding — `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, indexed `docs/`, per-workspace `AGENTS.md`, `core-beliefs.md` | ✅ shipped                            |
| **Tier 2** | Pre-commit hooks (`lefthook`/`husky`), `apps/server` ESLint, `docs/CONVENTIONS.md` + `docs/templates/`, `docs/README.md`     | In progress (2026-04-25 audit sprint) |
| **Tier 3** | `scripts/check-invariants.ts` — mechanical CI checks for `core-beliefs.md` rules                                             | Planned                               |
| **Tier 4** | Production observability — structured logging (pino), Sentry, distributed analyzer lock, heartbeat circuit breaker           | Planned                               |
| **Tier 5** | GC agent — recurring cleanup PRs, quality-grade refresh, stale-doc detection                                                 | Planned                               |

When you write or update a doc, place yourself in the rollout: are you adding scaffolding, enforcement, observability, or maintenance? The Tier system is the team's existing harness-engineering vocabulary; new docs use it rather than inventing parallel terms.

## See also

- [`README.md`](README.md) — the navigation map for `docs/`.
- [`templates/`](templates/) — shapes for each doc type.
- [`design-docs/index.md`](design-docs/index.md) — index of topic-level design decisions.
- [`design-docs/core-beliefs.md`](design-docs/core-beliefs.md) — load-bearing rules.
- Root [`AGENTS.md`](../AGENTS.md) — the project map.
