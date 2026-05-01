---
"@slashtalk/electron": patch
---

Fix `spawn ENOTDIR` from the Ask window's local agent in the installed `.app` (still failing after the earlier `asarUnpack` fix). The Claude Agent SDK resolves its native `claude` binary via `require.resolve`, which lands at a path inside `app.asar`. Electron auto-translates `fs.*` reads across asar/asar.unpacked, but it does **not** rewrite `child_process.spawn` paths — so the spawn fails because `app.asar` is a regular file, not a directory. Add `apps/desktop/src/main/claudeBin.ts` that computes the unpacked path under `app.asar.unpacked/` (handling both nested and top-level package layouts) and pass it as `pathToClaudeCodeExecutable` to the SDK from both `chatDelegate.ts` and `localAgent.ts`. Returns undefined in dev so the SDK's own resolver runs against on-disk node_modules.
