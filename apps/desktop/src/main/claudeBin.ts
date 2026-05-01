// Resolves the bundled Claude Agent SDK CLI binary's real on-disk path so the
// SDK's `query()` can spawn it. In dev, returning undefined lets the SDK do
// its own require-resolve from on-disk node_modules. In a packaged .app the
// SDK's resolver lands at `app.asar/...` and `child_process.spawn` then fails
// with ENOTDIR (Electron does not rewrite spawn paths from asar to
// asar.unpacked — only fs.* APIs are patched). The platform-specific package
// is in our `asarUnpack` glob, so the real file lives at `app.asar.unpacked/`
// — point the SDK there directly via `pathToClaudeCodeExecutable`.

import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/** Path to the unpacked `claude` binary, or undefined if it can't be located.
 *  Always undefined in dev: the SDK's own resolver works correctly there. */
export function resolveBundledClaudeBin(): string | undefined {
  if (!app.isPackaged) return undefined;

  const ext = process.platform === "win32" ? ".exe" : "";
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const unpackedRoot = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules");

  // Bun hoists most workspace deps to the root node_modules, but the SDK's
  // platform-specific binary often ends up nested under the SDK package's own
  // node_modules in the packaged asar (verified: `npx asar list app.asar`).
  // Try both layouts.
  const candidates = [
    path.join(
      unpackedRoot,
      "@anthropic-ai/claude-agent-sdk/node_modules",
      platformPkg,
      `claude${ext}`,
    ),
    path.join(unpackedRoot, platformPkg, `claude${ext}`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
