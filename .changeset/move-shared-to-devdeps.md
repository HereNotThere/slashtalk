---
"@slashtalk/electron": patch
---

Fix `dist:mac` build failure introduced by the previous `asarUnpack` change. With an unpack matcher present, electron-builder's filter runs `getRelativePath` on every file, which threw on workspace-symlinked files like `packages/shared/AGENTS.md` (canonical path lives outside `apps/desktop/`). Move `@slashtalk/shared` from `dependencies` to `devDependencies` in `apps/desktop/package.json` so electron-builder skips it during asar packaging entirely. Safe because the package is purely build-time: Vite bundles it into `out/main/index.js`, the preload only `import type`s it, and the renderer bundles it by default — no runtime `require("@slashtalk/shared")`.
