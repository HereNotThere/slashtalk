// Read-only Claude Agent SDK runner for chat delegation. Allowlist (not
// bypassPermissions) is the safety boundary since this runs headless — no
// human-in-the-loop dialog to fall back on.

import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentStreamEvent } from "./anthropic";
import { normalizeSdkMessage } from "./sdkEvents";

const execFileAsync = promisify(execFile);

// Cached process-wide; install state changes only across app restarts.
let claudeCliCache: Promise<boolean> | null = null;

export function hasClaudeCli(): Promise<boolean> {
  if (!claudeCliCache) {
    claudeCliCache = execFileAsync("claude", ["--version"], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }
  return claudeCliCache;
}

/** Read-only tools the chat-delegated agent is allowed to use without
 *  prompting. Patterns match the same syntax Claude Code's settings.json
 *  permission rules use: `Bash(<prefix>:*)` matches commands whose first
 *  whitespace-separated word(s) match `<prefix>`. */
export const READ_ONLY_ALLOWLIST: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  // Filesystem read commands.
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(find:*)",
  "Bash(rg:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  // Git read-only.
  "Bash(git log:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git ls-files:*)",
  "Bash(git branch:*)",
  "Bash(git remote:*)",
  "Bash(git rev-parse:*)",
  // Build/test (read-only effects on the repo, but they do execute code —
  // intentional: the user is asking why typecheck/test fails).
  "Bash(bun run typecheck)",
  "Bash(bun run test)",
  // GitHub remote (authoritative for PR/CI state — server's pull_requests
  // table is best-effort and lags behind). `gh api` is intentionally NOT on
  // the list: it's a raw escape hatch to any REST/GraphQL endpoint, including
  // POST/PUT/PATCH/DELETE (merge PRs, delete branches, …) — that breaks the
  // read-only contract.
  "Bash(gh pr view:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh pr status:*)",
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
  "Bash(gh issue view:*)",
  "Bash(gh issue list:*)",
  "Bash(gh repo view:*)",
];

/** Defense in depth: even if a future allowlist edit accidentally permits
 *  something edit-shaped, these are hard-denied. */
export const DISALLOWED_TOOLS: readonly string[] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

const SYSTEM_PROMPT = `You are answering a question on behalf of the slashtalk Ask window. The user is in a chat surface, not an editor — they want a single concise answer, not a back-and-forth.

Tools you have:
- Read, Grep, Glob — for navigating the repo source.
- Bash — for read-only commands only: git log/status/diff/show/blame, ls/cat/rg/find, bun run typecheck, bun run test, and gh (PR/CI/issue queries against the GitHub remote).
- You CANNOT edit files, run installers, push, or invoke any command not on the allowlist. If a tool call is denied, it's by design — work around it or answer with what you have.

Behavior:
- Investigate the repo to ground your answer in actual code/git/CI state, then return a single concise markdown answer.
- Don't ask the user clarifying questions; commit to your best interpretation.
- For PR/CI questions, prefer \`gh pr view\` / \`gh run list\` (authoritative, fresh) over inferring from local state.
- Keep the final answer tight: prose summary + a short list of citations (file:line, commit SHA, or PR URL) when relevant.

Markdown links: always use absolute \`https://github.com/<owner>/<repo>/...\` URLs. Never emit relative paths like \`../../pull/186\` or \`/pull/186\` — \`gh\` often outputs these and they break in our chat surface. If you don't know the slug, run \`gh repo view --json nameWithOwner -q .nameWithOwner\` once.`;

const denyByDefault: CanUseTool = async (toolName) => {
  const result: PermissionResult = {
    behavior: "deny",
    message: `Slashtalk chat is read-only — \`${toolName}\` is not on the allowlist. If you need this, the user must run the question in a regular Claude Code session.`,
  };
  return result;
};

export interface RunDelegatedChatInput {
  task: string;
  cwd: string;
  onEvent: (e: AgentStreamEvent) => void;
}

export interface RunDelegatedChatResult {
  text: string;
  hadError: boolean;
}

export async function runDelegatedChat(
  input: RunDelegatedChatInput,
): Promise<RunDelegatedChatResult> {
  const { task, cwd, onEvent } = input;

  const options: Options = {
    cwd,
    model: "claude-sonnet-4-6",
    systemPrompt: SYSTEM_PROMPT,
    permissionMode: "default",
    allowedTools: [...READ_ONLY_ALLOWLIST],
    disallowedTools: [...DISALLOWED_TOOLS],
    canUseTool: denyByDefault,
    // Inherit the user's MCP servers + hooks from ~/.claude/settings.json.
    // Project/local scopes are intentionally omitted: they'd vary by cwd.
    settingSources: ["user"],
  };

  let finalText = "";
  let hadError = false;

  onEvent({ kind: "phase", label: "Investigating…" });

  try {
    const q = query({ prompt: task, options });
    for await (const msg of q) {
      // Read text off the raw SDKMessage (not the normalized event stream)
      // to preserve whitespace/ordering for the persisted final answer.
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) finalText += block.text;
        }
      } else if (msg.type === "result" && msg.subtype !== "success") {
        hadError = true;
      }
      for (const e of normalizeSdkMessage(msg)) onEvent(e);
    }
  } catch (err) {
    hadError = true;
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ kind: "error", message });
  }

  return { text: finalText.trim(), hadError };
}
