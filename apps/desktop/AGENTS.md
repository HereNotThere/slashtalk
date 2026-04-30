# apps/desktop (`@slashtalk/electron`)

Electron app for slashtalk. Built with `electron-vite` (main + preload + multi-window renderer).

> **Keep this file current.** When you change build commands, scripts, conventions, layout, or the pre-commit gate, update this file in the same change.

## Layout

- `src/main/` — Electron main process (Node)
- `src/preload/` — preload bridge (built as CJS — see `electron.vite.config.ts`)
- `src/renderer/{main,overlay,info,chat,response,statusbar}/` — six renderer windows, each with its own `index.html`. `chat` is a transparent pill-shaped "ask" popover anchored to the chat bubble at the bottom of the overlay rail; `response` is the result window that opens when you send a message
- `src/renderer/shared/tailwind.css` — single Tailwind v4 entrypoint (theme + base resets) imported by every window's `styles.css`
- `src/shared/` — types shared across processes
- `docs/` — deep dives on subsystems whose data flow or platform quirks aren't obvious from the code. See [`docs/rail-pinning.md`](docs/rail-pinning.md) before touching the rail's `alwaysOnTop` / `focusable` / activation-policy behavior, and [`docs/info-card.md`](docs/info-card.md) before changing info-window layouts, the dashboard fetch, the project-overview surface, or the time-window scope flag.
- `out/` — build output (gitignored)
- `dist/` — packaged installers from `electron-builder` (gitignored)
- `resources/` — runtime assets (e.g. `trayTemplate.png`/`@2x` for the macOS menu-bar icon). Loaded relative to `__dirname` from main process. Template PNGs use grayscale + alpha so macOS auto-tints to match the menu bar. Inside a packaged build, these are included in `app.asar` at the same relative path (`../../resources/…` from `out/main/`).
- `build/` — brand + packaging sources. `icon.svg` / `icon.png` are the Slashtalk logo source; `icon.iconset/` + `icon.icns` are generated from the SVG (`rsvg-convert` per-size → `iconutil -c icns`) and picked up automatically by electron-builder for the app/dock/Finder/DMG icons. `trayTemplate.svg` is the mono source for `resources/trayTemplate*.png` (rendered at 22px / 44px). Not shipped at runtime — only `resources/**` goes into `app.asar`.

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
bun run dist         # build + package via electron-builder → ./dist (host platform)
bun run dist:mac     # build + package macOS DMG/zip/update metadata → ./dist

bun run lint         # eslint .
bun run typecheck    # tsc --noEmit for node + web projects
bun run typecheck:node
bun run typecheck:web
```

From repo root you can also do `bun --filter @slashtalk/electron <script>`.

Install deps from repo root: `bun install` (this is a workspace package, do not run install inside `apps/desktop/`).

## Local development

By default the packaged desktop talks to the hosted services (`https://slashtalk.onrender.com` for the API and `/mcp` on the same server for remote MCP). Local Claude Code and Codex installs point at the desktop-local proxy (`http://127.0.0.1:37613/mcp`) so the device API key stays in Electron `safeStorage` instead of AI-client config files.

To point the desktop at a locally-running backend instead, create `apps/desktop/.env` with:

```
MAIN_VITE_SLASHTALK_API_URL=http://localhost:10000
```

`MAIN_VITE_SLASHTALK_MCP_URL` remains available as a remote-MCP escape hatch for the desktop proxy and self-session client, but the default remote target is `MAIN_VITE_SLASHTALK_API_URL + /mcp`. `SLASHTALK_LOCAL_MCP_PORT` can override the local proxy port for testing.

Then start the backend and desktop from the repo root:

```sh
bun run dev:server
bun run dev:desktop
```

Or run each process separately:

```sh
# Terminal 1: slashtalk API server (port 10000)
cd apps/server && bun run dev

# Terminal 2: desktop
cd apps/desktop && bun run dev
```

Notes:

- The `MAIN_VITE_` prefix is required — electron-vite only exposes prefixed env vars to the main process. Plain `SLASHTALK_*` in `.env` is ignored. (Plain `SLASHTALK_*` exported in your shell still works as a runtime override.)
- Keep API and explicit MCP override URLs pointed at the same environment. The desktop device apiKey is minted by the API server and accepted by the server-owned `/mcp` route for local-proxy and legacy compatibility. Direct Claude Code and Codex clients can also authenticate to the same `/mcp` route through MCP OAuth.
- The former standalone `apps/mcp` service has been removed. MCP local development runs through the server-owned `/mcp` route.
- For a hosted-API + local-everything-else dev session, comment the local URLs out and the desktop falls back to the hosted defaults.

## Packaging (electron-builder)

Config is inline in `package.json` under the `build` key. `files` is explicit — only `out/**`, `resources/**`, `package.json` are bundled, so no workspace `node_modules` copy is attempted (everything else is vite-bundled into `out/`). App icon lives at `build/icon.icns` (auto-picked by electron-builder) — regenerate from `build/icon.svg` via the `rsvg-convert` + `iconutil` steps noted in Layout if the logo changes.

Auto-update uses `electron-updater` with public GitHub Releases for `HereNotThere/slashtalk`. macOS builds are universal and must ship both `dmg` and `zip` targets plus `latest-mac.yml`; the zip is required by Squirrel.Mac update metadata even though users normally download the DMG. The release workflow uploads the DMG, zip, blockmaps, and `latest-mac.yml` to the `@slashtalk/electron@<version>` GitHub release.

### macOS signing + notarization

The `mac` block expects a Developer ID Application cert (signing) and Apple notarization credentials. Entitlements live at [`build/entitlements.mac.plist`](build/entitlements.mac.plist) — hardened runtime is on, with the JIT / unsigned-memory / library-validation / dyld-env entitlements that Electron + `koffi` (used by `src/main/macCorners.ts`) require. `notarize: true` lets electron-builder pick up credentials from the environment.

Set these env vars before `bun run dist:mac`:

```bash
# Signing (Developer ID Application cert exported as .p12)
export CSC_LINK=/path/to/cert.p12          # or base64 of the .p12
export CSC_KEY_PASSWORD=...

# Notarization — pick ONE of these two sets:

# (a) App Store Connect API key (recommended for CI)
export APPLE_API_KEY=/path/to/AuthKey_XXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# (b) Apple ID + app-specific password
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=XXXXXXXXXX
```

Verify the output:

```bash
codesign -dv --verbose=4 dist/mac/Slashtalk.app
spctl -a -vvv -t install dist/Slashtalk-*.dmg
xcrun stapler validate dist/Slashtalk-*.dmg
```

To build unsigned locally (skip the cert + notarize), unset `CSC_LINK` and pass `--config.mac.identity=null --config.mac.notarize=false` to electron-builder, or temporarily flip `notarize` off in `package.json`.

## Before committing

```bash
bun run lint
bun run typecheck
```

Both must pass.
