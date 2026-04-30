<h1 align="center">Slashtalk</h1>
<p align="center"><em>Coordination, without the meetings.</em></p>
<p align="center">
  <code>brew install --cask herenotthere/tap/slashtalk</code><br/>
  or <a href="https://github.com/HereNotThere/slashtalk/releases/latest/download/Slashtalk-mac-universal.dmg">download the latest .dmg</a>
</p>

<p align="center">
  <img src="apps/landing/public/screenshot-dock.png" alt="Slashtalk floating dock" width="80%" />
</p>

---

A floating dock that shows what your team is shipping. Recent PRs, live coding sessions, file conflicts before they happen. Built for small remote teams that move fast.

Slashtalk lives at the edge of your screen and quietly aggregates Claude Code session data, GitHub activity, and live work signals — organized around the repos your team actually owns. No more "what are you working on?" stand-ups, no more surprise merge conflicts, no more meetings that should have been a glance.

## Quickstart

1. **Install** — `brew install --cask herenotthere/tap/slashtalk` (macOS 11+), or grab the [latest DMG](https://github.com/HereNotThere/slashtalk/releases/latest).
2. **Launch** — Slashtalk lives in your menu bar. Click the icon to show the dock.
3. **Sign in with GitHub** — your active orgs appear; pick the repos you want on your dock.
4. **You're done** — sessions, PRs, and conflicts start appearing as your team works.

The desktop app updates itself via `electron-updater` — no `brew upgrade` dance required.

## Docs

- [**Architecture**](ARCHITECTURE.md) — domain map: ingest, sessions, analyzers, websockets
- [**Development**](docs/DEVELOPMENT.md) — run the backend locally
- [**Releasing**](docs/RELEASING.md) — desktop release pipeline, signing, Homebrew tap
- [**Project map**](AGENTS.md) — workspace layout, per-app pointers
- [**Design docs**](docs/design-docs/) — core beliefs, decisions, exec plans
- [**Reliability**](docs/RELIABILITY.md) · [**Security**](docs/SECURITY.md)
