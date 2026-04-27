import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["out/**", "dist/**", "node_modules/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Renderer (browser globals + React rules)
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // Main + preload (node globals)
  {
    files: ["src/main/**/*.ts", "src/preload/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },

  // Disable rules that conflict with Prettier — keep this last.
  prettier,
];
