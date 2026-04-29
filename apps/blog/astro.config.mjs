// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// Served by apps/server under /blog — see apps/server/src/web/blog-routes.ts.
// https://astro.build/config
export default defineConfig({
  base: '/blog',
  trailingSlash: 'ignore',
  vite: {
    plugins: [tailwindcss()],
  },
});
