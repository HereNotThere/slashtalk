# apps/desktop (`@slashtalk/electron`)

Electron app for slashtalk. Built with `electron-vite` (main + preload + multi-window renderer).

> **Keep this file current.** When you change build commands, scripts, conventions, layout, or the pre-commit gate, update this file in the same change.

## Layout

- `src/main/` — Electron main process (Node)
- `src/preload/` — preload bridge (built as CJS — see `electron.vite.config.ts`)
- `src/renderer/{main,overlay,info,statusbar}/` — four renderer windows, each with its own `index.html`
- `src/shared/` — types shared across processes
- `out/` — build output (gitignored)

## Commands

Run from `apps/desktop/`:

```bash
bun run dev          # electron-vite dev (HMR for renderers, restarts main)
bun run build        # electron-vite build → ./out
bun run start        # electron-vite preview (run the built app)

bun run lint         # eslint .
bun run typecheck    # tsc --noEmit for node + web projects
bun run typecheck:node
bun run typecheck:web
```

From repo root you can also do `bun --filter @slashtalk/electron <script>`.

Install deps from repo root: `bun install` (this is a workspace package, do not run install inside `apps/desktop/`).

## Before committing

```bash
bun run lint
bun run typecheck
```

Both must pass.
