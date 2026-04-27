/** @type {import('lint-staged').Configuration} */
export default {
  // Desktop TS/JS goes through eslint --fix, then prettier.
  "apps/desktop/**/*.{ts,tsx,js,jsx}": (files) => [
    `bunx eslint --fix --config apps/desktop/eslint.config.js ${files.join(" ")}`,
    `prettier --write ${files.join(" ")}`,
  ],

  // Everything else prettier handles (skip desktop to avoid double-formatting).
  "!(apps/desktop/**)*.{ts,tsx,js,jsx,json,md,yml,yaml,css,html}": "prettier --write",
};
