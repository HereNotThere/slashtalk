# Design docs

Durable decisions and mental models for slashtalk. One doc per topic, not a kitchen sink.

For the broader docs map, see [`../README.md`](../README.md). For authoring rules, see [`../CONVENTIONS.md`](../CONVENTIONS.md). For the page shape, see [`../templates/design-doc.md`](../templates/design-doc.md).

## Canonical beliefs

- [Core beliefs](core-beliefs.md) — the rules that can't be broken. Tier-3 of the harness plan will enforce each mechanically.

## Cross-cutting models

These are top-level cross-cutting specs — UPPERCASE filenames at `docs/` root rather than under this subdirectory because they're treated as always-load tier (LICENSE / SECURITY / CONTRIBUTING analog). See [`../CONVENTIONS.md#the-two-tier-docs-hierarchy`](../CONVENTIONS.md#the-two-tier-docs-hierarchy) for why this placement is deliberate.

- [Reliability](../RELIABILITY.md) — ingest resume protocol, heartbeat state machine, Redis soft-fail, analyzer scheduler.
- [Security](../SECURITY.md) — OAuth scope, token encryption, PII surface, credential storage.
- [Quality score](../QUALITY_SCORE.md) — per-domain health grades.

## Topic-level design docs

(One file per topic in this subdirectory. Add new entries here as they're written.)

- _(none yet beyond `core-beliefs.md` — new design decisions land here as `<topic>.md`)_

## Product specs

- [`product-specs/backend.md`](../product-specs/backend.md) — hosted backend spec (ingest, feed, WS).
- [`product-specs/upload.md`](../product-specs/upload.md) — delta-sync upload protocol.
- [`product-specs/webapp-pwa.md`](../product-specs/webapp-pwa.md) — `apps/web` PWA scope, push notifications, and web/desktop code-sharing boundaries.

## References (3rd-party libs)

- [`references/`](../references/) — `<library>-llms.txt` per pinned dependency. Format and add-a-reference workflow in [`references/README.md`](../references/README.md).

## Adding a design doc

1. Copy [`../templates/design-doc.md`](../templates/design-doc.md) to `docs/design-docs/<topic>.md` (kebab-case).
2. Fill in the template's sections — Decision, Why, How to apply, Alternatives considered.
3. Link the new doc from this index under "Topic-level design docs."
4. If the decision is **load-bearing** — i.e. future work must respect it — also add a one-line entry in [`core-beliefs.md`](core-beliefs.md) so it shows up in Tier-3 enforcement scans.
5. If the decision warrants preserving the alternatives-considered trail in append-only form, also write a corresponding ADR in `docs/decisions/<NNNN>-<slug>.md` (template at [`../templates/adr.md`](../templates/adr.md)).
