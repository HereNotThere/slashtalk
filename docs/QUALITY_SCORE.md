# Quality score

Per-domain health grades. Baseline written 2026-04-24 against the snapshot in [`generated/db-schema.md`](generated/db-schema.md) and [CLAUDE.md](../CLAUDE.md) "Implementation status." A future GC agent (harness plan Tier 5) will keep this file current.

## Scoring rubric

| Grade | Meaning                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------- |
| **A** | Load-bearing tests exist, CLAUDE.md claims match code, no known gaps in `tech-debt-tracker.md`. |
| **B** | Tests cover happy path; 1–2 open gaps; a correctness bug would have a visible symptom.          |
| **C** | Minimal tests; key behaviors only exercised in manual QA.                                       |
| **D** | Relied upon in production but near-zero tests; a regression would land silently.                |
| **F** | Known broken or vestigial.                                                                      |

Columns: **Tests** (coverage depth), **Docs** (does CLAUDE.md/AGENTS.md/specs describe reality), **Invariants** (count of `core-beliefs.md` rules this domain is subject to), **Open gaps**.

## Server domains

| Domain                        | Tests | Docs | Invariants | Open gaps                                                                                   | Overall |
| ----------------------------- | ----- | ---- | ---------- | ------------------------------------------------------------------------------------------- | ------- |
| `ingest`                      | B     | A    | 3          | orphaned tool results across batches; `prefixHash` unused for validation                    | **B**   |
| `sessions` / state machine    | B     | A    | 2          | `/api/feed/users` N+1                                                                       | **B**   |
| `social` / PR poller          | C     | B    | 1          | process-restart re-baselines from head (no replay)                                          | **C**   |
| `analyzers`                   | D     | B    | 3          | no unit tests; `llm.ts` has no retries/timeouts; in-proc tick lock only; no token budgeting | **D**   |
| `ws` / Redis bridge           | C     | A    | 2          | no dedup on reconnect (clients rely on `/api/feed` as source of truth)                      | **C**   |
| `auth`                        | B     | A    | 3          | none known                                                                                  | **B**   |
| `user` / devices / repo-claim | B     | A    | 2          | repo-claim doesn't cache; every ingest retries all 3 matching strategies                    | **B**   |
| `chat`                        | C     | B    | 1          | integration test mocks insight; no eval harness                                             | **C**   |

## Desktop

| Domain                               | Tests | Docs | Invariants | Open gaps                                                                 | Overall |
| ------------------------------------ | ----- | ---- | ---------- | ------------------------------------------------------------------------- | ------- |
| `uploader` (fs.watch + `/v1/ingest`) | D     | A    | 2          | no dead-letter; no partial-upload rollback; tracked=null reset on startup | **D**   |
| `heartbeat`                          | D     | A    | 1          | no backoff on server down                                                 | **D**   |
| `backend` HTTP client                | D     | A    | 1          | no timeout on fetch; one-shot 401 retry only; no circuit breaker          | **D**   |
| `ws` client                          | C     | A    | 1          | no dedup/replay; reconnect backoff 1s→30s                                 | **C**   |
| `localRepos`                         | C     | B    | 1          | no TTL; server-side changes only reflected at sign-in                     | **C**   |
| Renderer windows (7)                 | F     | B    | 0          | zero unit tests (one weather util)                                        | **F**   |

## Shared

| Domain                    | Tests | Docs | Invariants | Open gaps  | Overall |
| ------------------------- | ----- | ---- | ---------- | ---------- | ------- |
| `@slashtalk/shared` types | B     | A    | 1          | none known | **B**   |

## How to update

- **Bump a grade** when the supporting evidence changes (new tests land; a gap is closed).
- **Add a domain** when a new subsystem ships — stay ≤3 lines per row.
- **Delete a domain** when code for it is removed.

The Tier 5 GC agent ingests this file plus `tech-debt-tracker.md` plus test results, re-grades, and opens a `chore(gc):` PR when the grade changes. Hand-edits are fine; the agent diffs against the committed file and only rewrites if it can provide evidence.
