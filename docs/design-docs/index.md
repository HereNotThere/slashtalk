# Design docs

Durable decisions and mental models. Aim for one doc per topic, not a kitchen sink.

## Canonical beliefs

- [Core beliefs](core-beliefs.md) — the rules that can't be broken. Tier-3 of the harness plan will enforce each mechanically.

## Cross-cutting models

- [Reliability](../RELIABILITY.md) — ingest resume protocol, heartbeat state machine, Redis soft-fail, analyzer scheduler.
- [Security](../SECURITY.md) — OAuth scope, token encryption, PII surface, credential storage.
- [Quality score](../QUALITY_SCORE.md) — per-domain health grades.

## Product specs

- [`product-specs/backend.md`](../product-specs/backend.md) — hosted backend spec (ingest, feed, WS).
- [`product-specs/upload.md`](../product-specs/upload.md) — delta-sync upload protocol.

## References (3rd-party libs)

- [`references/`](../references/) — version + gotchas + upstream links for `elysia`, `drizzle`, `ioredis`, `electron`, `anthropic-sdk`.

## Adding a design doc

1. Create `docs/design-docs/<topic>.md`.
2. Open with one paragraph of context (why this was decided), then the decision, then the alternatives you rejected.
3. Link it from this index.
4. If the decision is **load-bearing** — i.e. future work must respect it — also add a one-line entry in [`core-beliefs.md`](core-beliefs.md) so it shows up in Tier-3 enforcement scans.
