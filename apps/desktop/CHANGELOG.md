# @slashtalk/electron

## 0.0.4

### Patch Changes

- 76aaa4c: Disable `installAppDeps` in electron-builder. Bun isn't a drop-in npm replacement here — electron-builder's app-deps step invokes `node /path/to/bun` which fails with `SyntaxError: Invalid or unexpected token` on the Bun binary. Vite already bundles all production code into `out/`, so there's nothing to install.

## 0.0.3

### Patch Changes

- f5bac26: Pin `electronVersion` in the build config so macOS release builds succeed when Bun workspace-hoists `electron` to the repo root.

## 0.0.2

### Patch Changes

- cdabdaf: Initial release test.
