# apps/desktop (`@slashtalk/electron`)

Electron app for slashtalk. Built with `electron-vite` (main + preload + multi-window renderer).

> **Keep this file current.** When you change build commands, scripts, conventions, layout, or the pre-commit gate, update this file in the same change.

## Layout

- `src/main/` — Electron main process (Node)
- `src/preload/` — preload bridge (built as CJS — see `electron.vite.config.ts`)
- `src/renderer/{main,overlay,info,statusbar}/` — four renderer windows, each with its own `index.html`
- `src/renderer/shared/tailwind.css` — single Tailwind v4 entrypoint (theme + base resets) imported by every window's `styles.css`
- `src/shared/` — types shared across processes
- `out/` — build output (gitignored)

## Styling

Tailwind v4 via `@tailwindcss/vite`. Use utility classes in JSX. Each window's `styles.css` imports `../shared/tailwind.css` (and may add window-specific `@layer base` overrides — e.g. `main/styles.css` makes the body opaque). No PostCSS config; v4 handles it.

### Design tokens

All colors and semantic spacings are CSS variables defined in `src/renderer/shared/tailwind.css` under `@theme`. Use the named utilities in JSX, **never** arbitrary hex/rgba values:

- Color: `bg-bg`, `bg-card`, `bg-button`, `bg-button-hover`, `bg-accent`, `bg-accent-hover`, `bg-surface`, `bg-surface-hover`, `bg-surface-strong`, `bg-surface-strong-hover`, `bg-tile`, `bg-tile-hover`, `bg-bubble`, `bg-code`, `bg-divider`, `text-fg`, `text-muted`, `text-subtle`, `text-link`, `text-link-hover`, `text-accent-fg`, `text-danger`, `text-success`, `border-border`, `outline-bubble-outline`. Opacity modifiers (`text-fg/60`) work.
- Semantic spacing (t-shirt scale, works with `p-/m-/gap-/space-x-/space-y-`): `xs` 4px · `sm` 8px · `md` 12px · `lg` 16px · `xl` 24px · `2xl` 32px. Everything in between uses Tailwind's default numeric scale (`p-1`=4px, `p-2.5`=10px, etc.).

### Theming

Three modes: `dark`, `light`, `system`. Set via `setThemeMode()` from `src/renderer/shared/theme.ts` (persisted in `localStorage` under `chatheads.theme`; default = `system` follows `prefers-color-scheme`). Each window's `main.tsx` calls `initTheme()` before render. Tokens swap automatically — no `dark:` variants needed in JSX.

Adding a new color: add it to `@theme` (dark default) **and** to both light overrides (the `:root.theme-light` block AND the `prefers-color-scheme: light` media query). Both blocks must stay in sync.

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
