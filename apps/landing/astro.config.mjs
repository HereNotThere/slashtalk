// @ts-check
import { defineConfig } from 'astro/config';

// Tailwind 4 is wired in via postcss (postcss.config.mjs) instead of
// @tailwindcss/vite. The Vite plugin pulls a peer of vite that conflicts
// with the workspace-hoisted vite 5 from apps/desktop and apps/web,
// breaking `astro build`. PostCSS sidesteps the peer-dep entirely.

// Served by apps/server at / — see apps/server/src/landing/routes.ts.
// `site` is the canonical origin used to build absolute URLs for og:image,
// twitter:image, sitemap, etc. Override at build time with SITE_URL when
// deploying to a non-default origin.
// https://astro.build/config
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://slashtalk.com',
});
