import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Emit as .cjs so Node always parses as CommonJS, independent of the
        // outer package.json "type": "module". Electron's preload runner is
        // happiest with CJS even when main + renderer are ESM.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/main/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          info: resolve(__dirname, 'src/renderer/info/index.html'),
          chat: resolve(__dirname, 'src/renderer/chat/index.html'),
          response: resolve(__dirname, 'src/renderer/response/index.html'),
          statusbar: resolve(__dirname, 'src/renderer/statusbar/index.html'),
        },
      },
    },
  },
});
