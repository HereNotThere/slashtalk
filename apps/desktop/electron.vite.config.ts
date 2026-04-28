import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    // `@slashtalk/shared` is source-only (CLAUDE.md rule #5): its package.json
    // `main` points at `src/index.ts`, so Node can't load it as an external.
    // Bundle it into the main output instead — everything else (electron, node
    // built-ins, npm deps) stays external.
    plugins: [externalizeDepsPlugin({ exclude: ["@slashtalk/shared"] })],
    build: {
      // Defining build.rollupOptions below shadows electron-vite's automatic
      // dev-mode watch injection, leaving main as a one-shot build. Setting
      // watch:{} re-enables Rollup's watcher so edits trigger a rebuild +
      // electron app restart instead of needing a manual `bun run dev`.
      watch: {},
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      watch: {},
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        // Emit as .cjs so Node always parses as CommonJS, independent of the
        // outer package.json "type": "module". Electron's preload runner is
        // happiest with CJS even when main + renderer are ESM.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "src/renderer/main/index.html"),
          overlay: resolve(__dirname, "src/renderer/overlay/index.html"),
          info: resolve(__dirname, "src/renderer/info/index.html"),
          chat: resolve(__dirname, "src/renderer/chat/index.html"),
          response: resolve(__dirname, "src/renderer/response/index.html"),
          statusbar: resolve(__dirname, "src/renderer/statusbar/index.html"),
        },
      },
    },
  },
});
