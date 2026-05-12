// Resolves the user's locally-installed `claude` CLI binary for the SDK's
// `query()` to spawn. We no longer ship the ~200MB platform-specific binary
// from `@anthropic-ai/claude-agent-sdk-${platform}-${arch}` inside the .app
// (it more than doubled the DMG); instead we rely on the `claude` already on
// the user's machine.
//
// Resolution order (cached after first hit):
//   1. Walk `process.env.PATH` — fixPath() at startup already enriched PATH
//      with the user's shell PATH (Homebrew, version managers, etc.), so a
//      simple sync directory scan finds `claude` without a second shell spawn.
//   2. Hardcoded common install locations as paranoia for installers that
//      drop into dirs not exported from any rc file (Bun, Volta, npm-global).
//
// In dev (unpackaged), returns undefined so the SDK uses its own require-
// resolve against the locally-installed platform package — keeps dev fast and
// independent of whether the developer has `claude` on PATH.

import { app } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let cached: string | null | undefined;

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function viaPath(): string | undefined {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const sep = process.platform === "win32" ? ";" : ":";
  const entries = (process.env.PATH ?? "").split(sep);
  for (const dir of entries) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function fromKnownLocations(): string | undefined {
  const home = os.homedir();
  const candidates = [
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    path.join(home, ".local/bin/claude"),
    path.join(home, ".bun/bin/claude"),
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".volta/bin/claude"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && isExecutable(p)) return p;
  }
  return undefined;
}

export function resolveSystemClaudeBin(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const found = viaPath() ?? fromKnownLocations();
  cached = found ?? null;
  return found;
}

/** Path to a `claude` binary the SDK can spawn, or undefined.
 *
 *  In dev, returning undefined lets the SDK do its own require-resolve from
 *  on-disk node_modules. In packaged builds we no longer ship the binary, so
 *  we locate the user's system install instead. */
export function resolveBundledClaudeBin(): string | undefined {
  if (!app.isPackaged) return undefined;
  return resolveSystemClaudeBin();
}

export const CLAUDE_NOT_FOUND_MESSAGE =
  "Claude Code CLI not found on this machine. Install it from " +
  "https://docs.claude.com/en/docs/claude-code/setup, then restart Slashtalk.";
