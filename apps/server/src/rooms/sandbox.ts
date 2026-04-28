import { Sandbox } from "e2b";
import { config } from "../config";

export interface AgentDef {
  systemPrompt: string;
  model: string;
  mcpServers?: Array<{ name: string; url: string }>;
}

export interface ProvisionOpts {
  repoCloneUrl: string;
  gitUser: { name: string; email: string };
  agentDef: AgentDef;
}

// Each line of `claude --print --output-format stream-json` is one of these.
// Shape kept loose — the room window discriminates on `type` and renders.
// `session_id` is on every event; `result.result` carries the final assistant
// text on the closing `result` event.
export interface AgentEvent {
  type: string;
  session_id?: string;
  result?: string;
  [k: string]: unknown;
}

export interface AgentTurnOpts {
  prompt: string;
  onEvent?: (event: AgentEvent) => void;
  onStderr?: (chunk: string) => void;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface AgentTurnResult {
  exitCode: number;
  diffStat: DiffStat;
  text: string;
  sessionId: string | null;
}

export interface SandboxAdapter {
  provision(opts: ProvisionOpts): Promise<{ sandboxId: string }>;
  resume(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  runAgentTurn(sandboxId: string, opts: AgentTurnOpts): Promise<AgentTurnResult>;
  diff(sandboxId: string): Promise<string>;
}

// E2B base template runs as the `user` user (home /home/user). Cloning into
// the user's home avoids the permission-denied at root that you'd hit with
// /workspace.
const WORKDIR = "/home/user/workspace";
// Sibling to WORKDIR — outside the repo so neither leaks into git diff /
// downloadable patches.
const AGENT_DEF_PATH = "/home/user/.slashtalk-agent.json";
// Persisted Claude Code session id — `claude --resume <id>` picks up
// conversation memory on subsequent turns. Captured from the first turn's
// `result` event and rewritten if Claude rotates it.
const SESSION_ID_PATH = "/home/user/.slashtalk-session";
const PROVISION_TIMEOUT_MS = 180_000;
const RESUME_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 600_000;

function requireApiKey(name: "E2B" | "ANTHROPIC", value: string | null): string {
  if (!value) throw new Error(`${name}_API_KEY is required for room operations`);
  return value;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function parseDiffStat(out: string): DiffStat {
  const m = out.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  );
  if (!m) return { filesChanged: 0, insertions: 0, deletions: 0 };
  return {
    filesChanged: parseInt(m[1]!, 10),
    insertions: m[2] ? parseInt(m[2], 10) : 0,
    deletions: m[3] ? parseInt(m[3], 10) : 0,
  };
}

async function connect(sandboxId: string, timeoutMs = RESUME_TIMEOUT_MS): Promise<Sandbox> {
  const apiKey = requireApiKey("E2B", config.e2bApiKey);
  return Sandbox.connect(sandboxId, { apiKey, timeoutMs });
}

async function readPriorSessionId(sandbox: Sandbox): Promise<string | null> {
  try {
    const raw = await sandbox.files.read(SESSION_ID_PATH);
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // First turn — file doesn't exist yet.
    return null;
  }
}

export const e2bAdapter: SandboxAdapter = {
  async provision({ repoCloneUrl, gitUser, agentDef }) {
    const apiKey = requireApiKey("E2B", config.e2bApiKey);
    const sandbox = await Sandbox.create({ apiKey, timeoutMs: PROVISION_TIMEOUT_MS });

    // Default E2B base template doesn't ship Claude Code — install on first
    // provision. ~15s; baked-in template would eliminate this for prod.
    await sandbox.commands.run("npm install -g @anthropic-ai/claude-code", {
      timeoutMs: 120_000,
    });

    // Clone with the user's read-only OAuth token (CLAUDE.md #11). The token
    // is embedded in the URL — fine inside the sandbox; the URL never leaves.
    await sandbox.commands.run(`git clone ${shellQuote(repoCloneUrl)} ${shellQuote(WORKDIR)}`, {
      timeoutMs: 120_000,
    });
    await sandbox.commands.run(
      `git -C ${shellQuote(WORKDIR)} config user.name ${shellQuote(gitUser.name)}`,
    );
    await sandbox.commands.run(
      `git -C ${shellQuote(WORKDIR)} config user.email ${shellQuote(gitUser.email)}`,
    );

    await sandbox.files.write(AGENT_DEF_PATH, JSON.stringify(agentDef));

    return { sandboxId: sandbox.sandboxId };
  },

  async resume(sandboxId) {
    await connect(sandboxId);
  },

  async pause(sandboxId) {
    const sandbox = await connect(sandboxId, 30_000);
    await sandbox.pause();
  },

  async destroy(sandboxId) {
    const sandbox = await connect(sandboxId, 30_000);
    await sandbox.kill();
  },

  async runAgentTurn(sandboxId, { prompt, onEvent, onStderr }) {
    const anthropicKey = requireApiKey("ANTHROPIC", config.anthropicApiKey);
    const sandbox = await connect(sandboxId);

    const agentDefRaw = await sandbox.files.read(AGENT_DEF_PATH);
    const agentDef: AgentDef = JSON.parse(agentDefRaw);

    const priorSessionId = await readPriorSessionId(sandbox);

    // bypassPermissions is the right mode for a sandboxed agent that owns its
    // working tree — no human is around to approve writes interactively.
    // stream-json + --verbose emits one JSON event per line; we capture the
    // session id (every event carries it) and the final assistant text (on
    // the closing `result` event).
    const cmd = [
      "claude",
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      shellQuote(agentDef.model),
      "--append-system-prompt",
      shellQuote(agentDef.systemPrompt),
      ...(priorSessionId ? ["--resume", shellQuote(priorSessionId)] : []),
      shellQuote(prompt),
    ].join(" ");

    let buffer = "";
    let finalText = "";
    let nextSessionId: string | null = null;

    const handleStdout = (chunk: string): void => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event: AgentEvent;
        try {
          event = JSON.parse(line) as AgentEvent;
        } catch {
          continue;
        }
        if (typeof event.session_id === "string") nextSessionId = event.session_id;
        if (event.type === "result" && typeof event.result === "string") {
          finalText = event.result;
        }
        onEvent?.(event);
      }
    };

    const result = await sandbox.commands.run(cmd, {
      cwd: WORKDIR,
      envs: { ANTHROPIC_API_KEY: anthropicKey },
      onStdout: handleStdout,
      onStderr,
      timeoutMs: TURN_TIMEOUT_MS,
    });

    if (nextSessionId && nextSessionId !== priorSessionId) {
      await sandbox.files.write(SESSION_ID_PATH, nextSessionId);
    }

    // `git add -N` marks untracked files as intent-to-add so they appear in
    // `git diff` without actually staging them. Without this, new files the
    // agent created would be invisible to diff/--shortstat.
    await sandbox.commands.run(`git -C ${shellQuote(WORKDIR)} add -N .`);
    const stat = await sandbox.commands.run(`git -C ${shellQuote(WORKDIR)} diff --shortstat`);
    return {
      exitCode: result.exitCode,
      diffStat: parseDiffStat(stat.stdout),
      text: finalText,
      sessionId: nextSessionId,
    };
  },

  async diff(sandboxId) {
    const sandbox = await connect(sandboxId, 30_000);
    await sandbox.commands.run(`git -C ${shellQuote(WORKDIR)} add -N .`);
    const result = await sandbox.commands.run(`git -C ${shellQuote(WORKDIR)} diff`);
    return result.stdout;
  },
};
