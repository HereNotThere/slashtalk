# @slashtalk/blog

Public-facing blog and marketing site, built with Astro and served by `apps/server` under `/blog`.

## Layout

```text
apps/blog/
├── public/                  # static assets (favicon, screenshots) — copied as-is into dist/
├── src/
│   ├── layouts/Layout.astro # shared HTML shell
│   ├── pages/index.astro    # routes; each .astro/.md becomes a page
│   └── styles/global.css    # Tailwind v4 entry
├── astro.config.mjs         # base: '/blog' — must match the server mount
├── package.json
└── tsconfig.json
```

`base: '/blog'` is set in [`astro.config.mjs`](astro.config.mjs); the static build outputs to `dist/`, and `apps/server` serves it under `/blog/*` via [`apps/server/src/web/blog-routes.ts`](../server/src/web/blog-routes.ts). Reference public assets via `import.meta.env.BASE_URL` so links stay correct under the prefix.

## Commands

Run from `apps/blog/`:

| Command           | Action                                                 |
| :---------------- | :----------------------------------------------------- |
| `bun install`     | Install dependencies (run from repo root for monorepo) |
| `bun run dev`     | Astro dev server at `http://localhost:4321/blog`       |
| `bun run build`   | Build static site to `apps/blog/dist/`                 |
| `bun run preview` | Preview the production build locally                   |

The server falls back to a friendly "blog has not been built" message until `bun run build` produces `apps/blog/dist/`.

## Before committing

```sh
bun run build   # verifies the static build succeeds with the /blog base
```

If you change the mount point, update `base` here, the server route in [`apps/server/src/web/blog-routes.ts`](../server/src/web/blog-routes.ts), and the route table in [`AGENTS.md`](../../AGENTS.md) in the same commit.
