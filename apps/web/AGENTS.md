# apps/web (`@slashtalk/web`)

Installable React PWA for the authenticated Slashtalk product surface. The app is built as static files and served by `apps/server` under `/app/*` so browser auth can use same-origin httpOnly cookies.

> **Keep this file current.** When you change build commands, layout, service-worker scope, or the pre-commit gate, update this file in the same change.

## Layout

- `src/` — React app source.
- `src/App.tsx` — authenticated Team Now shell backed by same-origin `/api/*` calls.
- `src/main.tsx` — React entrypoint and service-worker registration.
- `src/styles.css` — app-local CSS. Shared UI should move to `packages/ui` before this grows.
- `public/` — PWA manifest, service worker, and app icons. The service worker is scoped to `/app/` in production.
- `dist/` — Vite build output, served by `apps/server/src/web/routes.ts` in production.

## Commands

Run from `apps/web/`:

```sh
bun run dev        # Vite dev server for the web app only
bun run build      # tsc + Vite build to ./dist
bun run preview    # preview the built app
bun run typecheck  # tsc --noEmit
```

From repo root you can also do `bun --filter @slashtalk/web <script>`.

Install deps from repo root: `bun install` (this is a workspace package, do not run install inside `apps/web/`).

## Same-Origin Contract

Production is served at `/app/*` by `apps/server`. Browser API calls use relative URLs (`/api/feed`, `/auth/github?return_to=/app/`) with `credentials: "include"`; do not put Slashtalk JWTs or device API keys in browser storage.

The browser app is read/control plane only. Local ingest, heartbeats, device repo paths, MCP proxy installation, local delegated agents, and local Spotify reads remain desktop-only.

## Before committing

```sh
bun run typecheck
bun run build
```

Both must pass.
