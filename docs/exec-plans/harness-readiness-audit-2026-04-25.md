# Harness-Readiness Audit — 2026-04-25

External audit of slashtalk-2 against the harness-readiness checklist defined in G's personal wiki. The checklist synthesizes harness-engineering practice from public practitioner writeups — Pang's CREAO essay, the Anatomy of an Agent Harness, and Tan's Thin Harness, Fat Skills, among others.

**Bottom line:** ~60% harness-ready. Excellent doc scaffolding, but Legibility has structural drift, Enforcement is half-built (server has no lint, no pre-commit hooks), Observability is missing (bare `console.log` everywhere, no error tracking), and there are no `.claude/` skill files. The team's own [`tech-debt-tracker.md`](./tech-debt-tracker.md) Tier 2 / Tier 3 entries already name most gaps; this audit confirms priority and adds two findings the tracker doesn't yet capture.

---

## The four-rung ladder

A repo is harness-ready when an agent can climb four rungs in order:

1. **Legibility** — can the agent see the system?
2. **Enforcement** — are the rules machine-checkable?
3. **Observability** — can the agent see what its actions did?
4. **Memory** — does the next run inherit what this run learned?

## Scorecard

| Rung | Status | One-line read |
| --- | --- | --- |
| 1. Legibility | **PARTIAL** | Doc set is unusually good in substance, but has a factual contradiction, two empty undocumented subdirs, no `docs/README.md`, and a two-tier hierarchy nobody explains. Surface looks YES; structure says PARTIAL. |
| 2. Enforcement | **PARTIAL** | TS strict + CI typecheck/test in place. **No lint in `apps/server`**, no pre-commit hooks, no `scripts/check-invariants.ts` for the 13 core-beliefs. |
| 3. Observability | **NO** | Bare `console.log` / `console.error` across analyzers, ingest, and ws bridge. No structured logger. No Sentry, no OTel. Local docker-compose is good; runtime is opaque. |
| 4. Memory | **PARTIAL** | `core-beliefs.md` (13 rules with Why + How) is best-in-class. **No `.claude/skills/`**, no ADRs by name, no runbooks. Per-workspace `AGENTS.md` files exist but freelance their structure. |

Workflow shape: short PRs and CI gates yes; planning docs sparse. Maintenance: deletion bias visible in git log; no scheduled cleanup automation.

---

## Rung 1 — Legibility (PARTIAL)

The first audit pass scored this YES because `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `README.md`, indexed `docs/`, and per-workspace `AGENTS.md` all exist. A stricter pass — "can a fresh agent find the right doc without guessing at the team's mental model?" — finds five real structural issues.

### 1.1 Factual contradiction: desktop window count

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) describes **seven windows** ("`main`, `overlay`, `info`, `chat`, `response`, `statusbar` + `trayPopup`, `dockPlaceholder`").
- [`apps/desktop/AGENTS.md`](../../apps/desktop/AGENTS.md) describes **six renderer windows** ("`main`, `overlay`, `info`, `chat`, `response`, `statusbar`").
- An agent asked to "fix `trayPopup`" reads the workspace doc, sees no mention, may conclude it's vestigial. **PR-quality risk: high.**

**Fix:** clarify in `ARCHITECTURE.md` which are renderer windows vs system chrome. Proposed line: *"Six renderer windows (`main`, `overlay`, `info`, `chat`, `response`, `statusbar`), plus `trayPopup` and `dockPlaceholder` as system-level chrome managed from the main process."*

### 1.2 Empty undocumented subdirectories

- [`docs/exec-plans/active/`](./active/) and [`docs/exec-plans/completed/`](./completed/) contain only `.gitkeep`.
- No `docs/exec-plans/README.md` documents intent.
- An agent asked to "file a plan for X" doesn't know whether to create a file in `active/` or alongside `tech-debt-tracker.md`.

**Fix:** add `docs/exec-plans/README.md` (5 lines) naming the convention.

### 1.3 No `docs/README.md` index

- [`docs/design-docs/index.md`](../design-docs/index.md) indexes design-docs only.
- `docs/` itself has no README. The directory listing alone reveals 6 markdown files, 5 subdirectories, and `.txt` files in `references/`.
- A fresh agent has no map of `docs/` from `docs/` itself; they have to discover the shape from `AGENTS.md` instead.

**Fix:** add `docs/README.md` (10–15 lines) with a one-line description per subdirectory and per root-level doc.

### 1.4 Implicit two-tier hierarchy

- [`docs/SECURITY.md`](../SECURITY.md), [`docs/RELIABILITY.md`](../RELIABILITY.md), and [`docs/QUALITY_SCORE.md`](../QUALITY_SCORE.md) sit at `docs/` root.
- [`docs/design-docs/core-beliefs.md`](../design-docs/core-beliefs.md) sits one level deeper.
- Both are durable rule documents. The placement difference is undocumented. Naming is also inconsistent — `SECURITY.md` (SCREAMING), `QUALITY_SCORE.md` (SCREAMING_SNAKE), `core-beliefs.md` (kebab), `references/*.txt` (.txt extension instead of .md).

**Fix:** either (a) move SECURITY/RELIABILITY/QUALITY_SCORE into `design-docs/` and update [`docs/design-docs/index.md`](../design-docs/index.md), or (b) add a "Root-level cross-cutting docs" subsection to `design-docs/index.md` that names them and explains the placement choice. Pick one naming convention and apply it.

### 1.5 No convention rule for `docs/references/`

- `docs/references/` contains `.txt` files (`anthropic-sdk-llms.txt`, `drizzle-llms.txt`, `electron-llms.txt`, `elysia-llms.txt`, `ioredis-llms.txt`).
- No README explains the convention. An agent asked to "add a pinning note for prisma" wouldn't know whether to create `prisma.txt`, `prisma-llms.txt`, `prisma.md`, or `prisma/index.md`.

**Fix:** add `docs/references/README.md` (3–5 lines) naming the file convention and what each file should contain.

### 1.6 Per-workspace AGENTS.md files freelance their shape

- [`apps/server/AGENTS.md`](../../apps/server/AGENTS.md) is a procedural manual with five "Adding X" recipes (~148 lines).
- [`apps/desktop/AGENTS.md`](../../apps/desktop/AGENTS.md) is a design-token reference (~70 lines, no recipes).
- [`apps/mcp/AGENTS.md`](../../apps/mcp/AGENTS.md) is a transitional/deprecation notice (~42 lines).
- [`packages/shared/AGENTS.md`](../../packages/shared/AGENTS.md) is a constraint definition (~35 lines).
- "Before committing" checklists are present but specify different command sets in each workspace.

An agent reading server's AGENTS.md learns to expect "Adding X" recipes; switching to desktop's, the structure changes entirely without explanation.

**Fix:** either (a) add a "Common tasks" / "Adding X" section header to every workspace AGENTS.md (even if some are intentionally short), or (b) add a paragraph to root [`AGENTS.md`](../../AGENTS.md) explaining the intentional shape difference per workspace ("server has recipes; desktop is design-token reference; mcp is transitional; shared is boundary definition").

### Sample-task navigation

| Task | Path verdict |
| --- | --- |
| Add a new ingest analyzer | **CLEAN** — root AGENTS.md → `apps/server/AGENTS.md#Adding-an-LLM-analyzer`, all files named explicitly. |
| Understand the auth model | **FORKED** — `SECURITY.md` + `ARCHITECTURE.md` + `core-beliefs.md` + `CLAUDE.md` all describe parts. Three sources, mild redundancy. |
| Understand the database schema | **CLEAN** — `docs/generated/db-schema.md` for read; `apps/server/AGENTS.md#Adding-a-database-column-or-table` for edit. |
| Load-bearing invariants | **CLEAN** — `core-beliefs.md` is the canonical 13-rule source. CLAUDE.md correctly redirects. |
| How desktop talks to server | **FORKED** — overview in `ARCHITECTURE.md`; desktop side in `apps/desktop/AGENTS.md`; server routes in `apps/server/AGENTS.md`. Three docs needed. |

---

## Rung 2 — Enforcement (PARTIAL)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Custom lints encoding taste invariants | **PARTIAL** | `apps/desktop/eslint.config.js` exists. **`apps/server` has no linter.** No repo-wide lints. No `scripts/check-invariants.ts` for the 13 core-beliefs (Tier 3 in `tech-debt-tracker.md` §18–20). |
| Structural tests | **PARTIAL** | `apps/server/test/` has 9 test files (~650 lines total — shallow for a multi-domain system). `apps/desktop` has 3 unit tests. No architectural-invariant tests (e.g., "every cross-user route joins `user_repos`", "every Elysia plugin has a unique `name`"). |
| Fast, reliable test suite | **YES** | `.github/workflows/ci.yml` runs `bun test` against containerized Postgres + Redis with health checks. |
| Type checking as first-class gate | **YES** | `tsconfig.json` has `strict: true`. CI runs `bun run typecheck` before tests. CLAUDE.md rule #9 mandates TS strict everywhere. |
| Pre-commit hooks matching local dev | **NO** | No `.husky/`, no `lefthook.yml`, no lint-staged. Pre-commit checklists are documented in `AGENTS.md` and `CLAUDE.md` and run by hand. |

**Notable asymmetry:** desktop has ESLint; server (the security-critical path with auth, ingest, `user_repos` gating) does not. Inverted from where the priority should be.

---

## Rung 3 — Observability (NO)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Worktree-local app instances | **YES** | `docker-compose.yml` spins up Postgres + Redis. Desktop points at local backend via `MAIN_VITE_SLASHTALK_API_URL`. Agents can run isolated copies. |
| Browser/UI access for frontend work | **PARTIAL** | Electron with HMR; DevTools attachable. **No Playwright/Puppeteer E2E setup.** |
| Local observability stack | **NO** | Bare `console.log` / `console.error` across `apps/server/src/analyzers/scheduler.ts`, ingest paths, ws bridge. No structured logger (pino/winston). No trace correlation. No metrics. |
| Production error feedback wired in | **NO** | No Sentry, no Datadog, no error tracking visible in code. `SECURITY.md` covers token encryption but observability is unmentioned. |

**Why this rung matters extra for slashtalk specifically:** the product itself is "make Claude Code coding sessions legible to humans." A repo whose own runtime is operationally illegible to its agents is a self-contradicting product story. Closing this is the single highest-leverage move for the codebase as a whole.

---

## Rung 4 — Memory (PARTIAL)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Skill files (`.claude/skills/*`) | **NO** | No `.claude/` directory. Recipes for "add a route", "add an analyzer", "add a DB table" exist as prose in `apps/server/AGENTS.md` but are not push-button skills. |
| Episodic decision capture | **PARTIAL** | `core-beliefs.md` encodes 13 rules with Why + How (excellent). `tech-debt-tracker.md` lists 20 tracked items. **No ADRs by name.** Recent commits show `feat/fix/refactor` style without rationale capture in PR descriptions. |
| Lessons / runbooks | **NO** | CLAUDE.md cites two memory slugs (`feedback_drizzle_journal_when`, `feedback_strict_tracking`) but no runbook files exist. No incident-response or "how we recovered from X" docs. |
| Folder-level identity | **PARTIAL** | Each workspace has an `AGENTS.md`. None have a `CLAUDE.md` or `.claude/` for sub-system memory. |

---

## The 5 sharpest gaps — ranked

Each gap names the rung, the cost, and a concrete first move.

### 1. No structured logging anywhere (Observability)

- **Cost:** mean-time-to-debug in production. An agent debugging a flaky ingest or analyzer crash has no logs to grep, no trace to follow.
- **Product cost:** see "why this rung matters extra" above.
- **First move:** adopt `pino` (Bun-native) with a single shared logger config in `packages/shared` or a new `packages/log`. Replace `console.*` in `apps/server/src/analyzers/`, ingest paths, and ws bridge first. Wire a single Sentry hook for unhandled errors. ~1 day.

### 2. No `apps/server/eslint.config.js` and no `scripts/check-invariants.ts` (Enforcement)

- **Cost:** the 13 load-bearing rules in `core-beliefs.md` live on human honor. An agent could merge a route that reads `user_repos`-gated data without joining `user_repos`, or mix auth schemes on a single Elysia plugin, with no mechanical check catching it.
- **First move:** mirror `apps/desktop/eslint.config.js` for `apps/server` with at minimum: (a) Elysia plugin-name uniqueness, (b) layering rules (no `apps/desktop` import from `apps/server` or vice versa), (c) ban `console.*` once pino lands. Tier 3 invariant script can come later. ~half a day for the lint.

### 3. No pre-commit hooks (Enforcement)

- **Cost:** explicit "before committing" checklists in `AGENTS.md` + `CLAUDE.md` are by hand. Easy to skip; an agent in a hurry will skip them.
- **First move:** add `lefthook.yml` running `bun run typecheck && bun run test && bun run gen:db-schema:check`. Tracks 1:1 to the existing manual checklist; no new behavior. ~half a day.

### 4. No `.claude/skills/` (Memory)

- **Cost:** every agent re-reads `AGENTS.md` recipes from scratch. The prose is already written; skills are free leverage.
- **First move:** lift the five "Adding X" sections from `apps/server/AGENTS.md` into `.claude/skills/add-route.md`, `add-analyzer.md`, `add-db-column.md`, etc. Reference them from root `AGENTS.md`. ~half a day.

### 5. Legibility structural fixes (Legibility)

- **Cost:** the docs are 80% there, but the gap between 80% and 100% is exactly the gap between "an agent can navigate without guessing" and "an agent stalls on a contradiction or empty directory."
- **First moves (one batch, ~1–2 hours):**
  1. Resolve the desktop window count contradiction in `ARCHITECTURE.md`.
  2. Add `docs/README.md`.
  3. Add `docs/exec-plans/README.md`.
  4. Add `docs/references/README.md`.
  5. Either move `SECURITY.md` / `RELIABILITY.md` / `QUALITY_SCORE.md` into `design-docs/` or document why they sit at root.
  6. Pick a filename convention (kebab vs SCREAMING) and apply.

---

## Three-day prescription

Three days of focused work moves this repo from ~60% to ~90% harness-ready by the checklist. Sequenced for highest leverage first:

| Day | Work | Outcome |
| --- | --- | --- |
| 1 | Adopt pino across `apps/server`. Wire Sentry hook for unhandled errors. | Closes Observability — the highest-leverage gap. |
| 2 (am) | Add `lefthook.yml` for typecheck + test + db-schema:check. | Mechanical pre-commit. |
| 2 (pm) | `apps/server/eslint.config.js` with layering + plugin-name + ban-console rules. | Closes asymmetry with desktop. |
| 3 (am) | Lift `AGENTS.md` "Adding X" recipes into `.claude/skills/*`. | Memory rung from PARTIAL → YES. |
| 3 (pm) | Legibility batch fix (window count, three READMEs, two-tier resolution, naming convention). | Legibility from PARTIAL → YES. |

After this sprint: Legibility YES, Enforcement YES (Tier 2 done; Tier 3 invariant script still deferred), Observability YES (basic), Memory YES (skills + core-beliefs + per-workspace AGENTS).

## Deferred (Tier 3)

- `scripts/check-invariants.ts` — mechanical enforcement of `core-beliefs.md` rules at CI time.
- Architectural-invariant tests in `apps/server/test/`.
- Desktop integration tests covering window lifecycle and IPC.
- ADR backfill for the durable decisions already in `core-beliefs.md`.
- Recurring cleanup agents.
- Health audits on a schedule.

---

## What this audit confirms

The team already operates with the harness-engineering frame. `core-beliefs.md`, the Tier 1 / Tier 2 / Tier 3 sequencing in `tech-debt-tracker.md`, the per-workspace `AGENTS.md` files, the `gen:db-schema:check` invariant — none of these are accidents. This repo is a harness-engineering rollout in progress, not a repo that ignored the discipline. The sharpest gaps are the ones the team has already named; this audit's job is to confirm priority, name two more findings (the desktop window contradiction, the `docs/` structural drift), and translate it all into a 3-day sprint.

## Open question for the team

Before acting on this audit:

- **Is the asymmetry intentional?** Desktop has ESLint, server doesn't. If this is a culture/preference choice ("we trust server review more than desktop"), the audit should reflect that. If it's a sequencing artifact (server lint was Tier 2 backlog), then it's a normal next step.
