// Astro auto-detects this and runs it on every CSS file. Tailwind 4
// works fine through PostCSS — see astro.config.mjs for the rationale.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
