import os from "node:os";
import path from "node:path";

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
export const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
export const CURSOR_PROJECTS_DIR = path.join(os.homedir(), ".cursor", "projects");
export const PI_SESSIONS_DIR = path.resolve(
  process.env["PI_CODING_AGENT_SESSION_DIR"] ??
    path.join(
      process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent"),
      "sessions",
    ),
);
