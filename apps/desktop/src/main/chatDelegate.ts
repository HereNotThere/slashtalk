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
import { resolveBundledClaudeBin } from "./claudeBin";
import { normalizeSdkMessage } from "./sdkEvents";

const execFileAsync = promisify(execFile);

// Cached process-wide; install/auth state changes only across app restarts.
function makeCliProbe(cmd: string, args: string[]): () => Promise<boolean> {
  let cache: Promise<boolean> | null = null;
  return () =>
    (cache ??= execFileAsync(cmd, args, { timeout: 5000 })
      .then(() => true)
      .catch(() => false));
}

export const hasClaudeCli = makeCliProbe("claude", ["--version"]);

// `gh auth status` exits 0 only when gh is installed AND authenticated against
// at least one host. Both states fail the same way at run time, so we collapse
// them into one capability bit.
export const hasGhCliReady = makeCliProbe("gh", ["auth", "status"]);

/** Always-on read tools — filesystem, git, build/test. Patterns match the
 *  same syntax Claude Code's settings.json permission rules use:
 *  `Bash(<prefix>:*)` matches commands whose first whitespace-separated
 *  word(s) match `<prefix>`. */
const BASE_ALLOWLIST: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(find:*)",
  "Bash(rg:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(git log:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git ls-files:*)",
  "Bash(git branch:*)",
  "Bash(git remote:*)",
  "Bash(git rev-parse:*)",
  "Bash(bun run typecheck)",
  "Bash(bun run test)",
];

/** GitHub remote (authoritative for PR/CI state — server's pull_requests
 *  table is best-effort and lags behind). Only enabled when `gh auth status`
 *  passes. `gh api` is intentionally absent: it's a raw escape hatch to any
 *  REST/GraphQL endpoint, including POST/PUT/PATCH/DELETE — that breaks the
 *  read-only contract. */
const GH_ALLOWLIST: readonly string[] = [
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

export const READ_ONLY_ALLOWLIST: readonly string[] = [...BASE_ALLOWLIST, ...GH_ALLOWLIST];

/** Defense in depth: even if a future allowlist edit accidentally permits
 *  something edit-shaped, these are hard-denied. */
export const DISALLOWED_TOOLS: readonly string[] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

function buildSystemPrompt(ghReady: boolean): string {
  const ghBashLine = ghReady
    ? "git log/status/diff/show/blame, ls/cat/rg/find, bun run typecheck, bun run test, and gh (PR/CI/issue queries against the GitHub remote)."
    : "git log/status/diff/show/blame, ls/cat/rg/find, bun run typecheck, bun run test. The `gh` CLI is NOT available on this machine (either not installed or not signed in).";

  // Don't ask the model to mention `gh auth login` in its prose — the
  // renderer's footer says it deterministically when ghAvailable is false.
  const ghBehaviorLine = ghReady
    ? "- For PR/CI questions, prefer `gh pr view` / `gh run list` (authoritative, fresh) over inferring from local state."
    : "- For PR/CI questions, you can only use git history (commits, branches, merged refs).";

  const linksLine = ghReady
    ? "Markdown links: always use absolute `https://github.com/<owner>/<repo>/...` URLs. Never emit relative paths like `../../pull/186` or `/pull/186` — `gh` often outputs these and they break in our chat surface. If you don't know the slug, run `gh repo view --json nameWithOwner -q .nameWithOwner` once."
    : "Markdown links: always use absolute `https://github.com/<owner>/<repo>/...` URLs. If you don't know the slug, parse it from `git remote get-url origin` (strip the `git@github.com:` or `https://github.com/` prefix and the trailing `.git`).";

  return `You are answering a question on behalf of the slashtalk Ask window. The user is in a chat surface, not an editor — they want a single concise answer, not a back-and-forth.

Tools you have:
- Read, Grep, Glob — for navigating the repo source.
- Bash — for read-only commands only: ${ghBashLine}
- You CANNOT edit files, run installers, push, or invoke any command not on the allowlist. If a tool call is denied, it's by design — work around it or answer with what you have.

Behavior:
- Investigate the repo to ground your answer in actual code/git/CI state, then return a single concise markdown answer.
- Don't ask the user clarifying questions; commit to your best interpretation.
${ghBehaviorLine}
- Keep the final answer tight: prose summary + a short list of citations (file:line, commit SHA, or PR URL) when relevant.

${linksLine}`;
}

export const denyByDefault: CanUseTool = async (toolName) => {
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
  /** Real reason a run failed (non-success `result` event from the SDK or a
   *  thrown error). Captured so the IPC handler can surface it instead of the
   *  generic "empty answer" message — most often this is a spawn/auth/PATH
   *  issue when the bundled .app launches without the user's shell env. */
  errorMessage: string | null;
  /** False when `gh auth status` failed at run start. The renderer surfaces
   *  this as a footer note so users know PR/CI answers are from local git
   *  only and may lag the remote. */
  ghAvailable: boolean;
}

export async function runDelegatedChat(
  input: RunDelegatedChatInput,
): Promise<RunDelegatedChatResult> {
  const { task, cwd, onEvent } = input;

  const ghAvailable = await hasGhCliReady();

  const bundledBin = resolveBundledClaudeBin();
  const options: Options = {
    cwd,
    model: "claude-sonnet-4-6",
    systemPrompt: buildSystemPrompt(ghAvailable),
    permissionMode: "default",
    allowedTools: [...(ghAvailable ? READ_ONLY_ALLOWLIST : BASE_ALLOWLIST)],
    disallowedTools: [...DISALLOWED_TOOLS],
    canUseTool: denyByDefault,
    // Inherit the user's MCP servers + hooks from ~/.claude/settings.json.
    // Project/local scopes are intentionally omitted: they'd vary by cwd.
    settingSources: ["user"],
    // In packaged builds the SDK's own resolver lands inside `app.asar`,
    // which spawn() can't traverse. See claudeBin.ts.
    ...(bundledBin ? { pathToClaudeCodeExecutable: bundledBin } : {}),
  };

  let finalText = "";
  let hadError = false;
  let errorMessage: string | null = null;

  onEvent({ kind: "phase", label: "Investigating…" });

  try {
    const q = query({ prompt: task, options });
    for await (const msg of q) {
      // Replace, don't append — the SDK yields a separate assistant message
      // per turn in the agentic loop. Intermediate turns ("Let me check
      // git log…") are narration alongside tool_use; only the FINAL turn's
      // text is the answer. Mirrors apps/server/src/chat/runner.ts.
      if (msg.type === "assistant") {
        const turnText = msg.message.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (turnText) finalText = turnText;
      } else if (msg.type === "result" && msg.subtype !== "success") {
        hadError = true;
        const detail = msg.errors?.join("\n") || `Agent run failed (${msg.subtype}).`;
        errorMessage = detail;
        console.error("[chat-delegate] SDK result error:", detail);
      }
      for (const e of normalizeSdkMessage(msg)) onEvent(e);
    }
  } catch (err) {
    hadError = true;
    const message = err instanceof Error ? err.message : String(err);
    errorMessage = message;
    console.error("[chat-delegate] SDK threw:", err);
    onEvent({ kind: "error", message });
  }

  return { text: finalText.trim(), hadError, errorMessage, ghAvailable };
}
