// @ts-check
import { defineConfig } from 'astro/config';

// Tailwind 4 is wired in via postcss (postcss.config.mjs) instead of
// @tailwindcss/vite. The Vite plugin pulls a peer of vite that conflicts
// with the workspace-hoisted vite 5 from apps/desktop and apps/web,
// breaking `astro build`. PostCSS sidesteps the peer-dep entirely.

// Served by apps/server under /blog — see apps/server/src/web/blog-routes.ts.
// https://astro.build/config
export default defineConfig({
  base: '/blog',
  trailingSlash: 'ignore',
});
