// Per-pid metadata files Claude writes to ~/.claude/sessions/{pid}.json while
// a session is live. Each file records `{ pid, sessionId, kind, cwd, version,
// startedAt }`. Both heartbeat (liveness gating) and the uploader (cwd
// fallback when the jsonl's first cwd line is buried past HEADER_BYTES)
// consume these — keep the reader here so they stay in sync.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

export interface ClaudeSessionMeta {
  sessionId: string;
  pid: number;
  kind?: string;
  cwd?: string;
  version?: string;
  startedAt?: string;
}

export async function readSessionMeta(filePath: string): Promise<ClaudeSessionMeta | null> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    console.error("[claudeSessionMeta] readFile failed", filePath, err);
    return null;
  }

  let parsed: {
    pid?: unknown;
    sessionId?: unknown;
    kind?: unknown;
    cwd?: unknown;
    version?: unknown;
    startedAt?: unknown;
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error("[claudeSessionMeta] malformed session file", filePath, err);
    return null;
  }

  const pid = typeof parsed.pid === "number" ? parsed.pid : null;
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  if (pid === null || !sessionId) return null;

  let startedAt: string | undefined;
  if (typeof parsed.startedAt === "number") {
    startedAt = new Date(parsed.startedAt).toISOString();
  } else if (typeof parsed.startedAt === "string") {
    startedAt = parsed.startedAt;
  }

  return {
    pid,
    sessionId,
    kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    version: typeof parsed.version === "string" ? parsed.version : undefined,
    startedAt,
  };
}

export async function listSessionMeta(
  dir: string = CLAUDE_SESSIONS_DIR,
): Promise<ClaudeSessionMeta[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[claudeSessionMeta] readdir failed", dir, err);
    }
    return [];
  }

  const out: ClaudeSessionMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const meta = await readSessionMeta(path.join(dir, name));
    if (meta) out.push(meta);
  }
  return out;
}

// Looks up the cwd recorded for a sessionId in any per-pid metadata file.
// Used by the uploader as a fallback when the jsonl's first `cwd` line is
// buried past HEADER_BYTES (e.g. a large opening prompt with image data).
export async function findCwdBySessionId(
  sessionId: string,
  dir: string = CLAUDE_SESSIONS_DIR,
): Promise<string | null> {
  const all = await listSessionMeta(dir);
  for (const meta of all) {
    if (meta.sessionId === sessionId && meta.cwd) return meta.cwd;
  }
  return null;
}

// Reverses `slugifyPath`: ~/.claude/projects/-Users-fei-repo/{uuid}.jsonl →
// /Users/fei/repo. Used as a last-resort cwd fallback in the uploader. Lossy
// when the original cwd contained `-` (e.g. `/Users/foo-bar/repo` decodes as
// `/Users/foo/bar/repo`), so callers must validate with `existsSync` and an
// authorization check before trusting the result.
export function decodeCwdFromProjectDir(filePath: string): string | null {
  const projectName = path.basename(path.dirname(filePath));
  if (!projectName.startsWith("-")) return null;
  return projectName.replaceAll("-", "/");
}
