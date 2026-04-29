# @slashtalk/landing

Public marketing homepage, built with Astro and served by `apps/server` at `/`.

## Layout

```text
apps/landing/
├── public/                  # static assets (favicon, screenshots) — copied as-is into dist/
├── src/
│   ├── layouts/Layout.astro # shared HTML shell
│   ├── pages/index.astro    # the homepage; each .astro/.md becomes a page
│   └── styles/global.css    # Tailwind v4 entry, with Inter + Instrument Serif
├── astro.config.mjs         # static build (no base prefix — site lives at /)
├── package.json
└── tsconfig.json
```

The site mounts at the apex (`/`), so links and asset paths are written without a base prefix. The server serves `dist/` via [`apps/server/src/landing/routes.ts`](../server/src/landing/routes.ts), which only exposes the explicit set of root files (`/`, `/_astro/*`, `/favicon.{svg,ico}`, `/screenshot-{dock,card,ask}.png`) so it never shadows API routes.

## Commands

Run from `apps/landing/`:

| Command           | Action                                                 |
| :---------------- | :----------------------------------------------------- |
| `bun install`     | Install dependencies (run from repo root for monorepo) |
| `bun run dev`     | Astro dev server at `http://localhost:4321`            |
| `bun run build`   | Build static site to `apps/landing/dist/`              |
| `bun run preview` | Preview the production build locally                   |

The server returns a friendly "landing page has not been built" message until `bun run build` produces `apps/landing/dist/`.

## Before committing

```sh
bun run build   # verifies the static build succeeds
```

If you add a new file at the landing root (e.g. `robots.txt`, `og-image.png`), register the corresponding `GET` in [`apps/server/src/landing/routes.ts`](../server/src/landing/routes.ts) — the server only serves an enumerated allowlist so it can sit at `/` without shadowing API routes.
