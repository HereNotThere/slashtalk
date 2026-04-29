// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// Served by apps/server at / — see apps/server/src/landing/routes.ts.
// `site` is the canonical origin used to build absolute URLs for og:image,
// twitter:image, sitemap, etc. Override at build time with SITE_URL when
// deploying to a non-default origin.
// https://astro.build/config
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://slashtalk.com',
  vite: {
    plugins: [tailwindcss()],
  },
});
