import path from "node:path";

const desktopRoot = path.resolve("apps/desktop");

/** @type {import('lint-staged').Configuration} */
export default {
  // Desktop TS/JS: eslint --fix runs from apps/desktop so the flat-config
  // `files` globs (e.g. `src/renderer/**`) resolve correctly. Then prettier.
  "apps/desktop/**/*.{ts,tsx,js,jsx}": (files) => {
    const relative = files.map((f) => path.relative(desktopRoot, f)).join(" ");
    return [
      `bash -c 'cd apps/desktop && bunx eslint --fix ${relative}'`,
      `prettier --write ${files.join(" ")}`,
    ];
  },

  // Everything else prettier handles (skip desktop to avoid double-formatting).
  "!(apps/desktop/**)*.{ts,tsx,js,jsx,json,md,yml,yaml,css,html}": "prettier --write",
};
