---
"@slashtalk/electron": patch
---

Fix `spawn ENOTDIR` when the Ask window's local agent runs in the installed `.app`. The Claude Agent SDK ships its native `claude` binary in platform-specific packages (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, etc.); electron-builder was packing those into `app.asar`, where the OS can't `spawn()` an executable because `app.asar` is a regular file from the kernel's perspective. Add an `asarUnpack` entry for `node_modules/@anthropic-ai/claude-agent-sdk-*/**` so the binaries land in `app.asar.unpacked/` and Electron's spawn handler can route to them. Worked in `bun run dev` because dev mode runs from on-disk node_modules, not asar.
