// Local-agent wrapper around @anthropic-ai/claude-agent-sdk. Mirrors the
// public shape of anthropic.ts so IPC handlers can dispatch by agent.mode
// with minimal branching. The SDK spawns a Claude Code subprocess inside
// this Electron main process and runs the agent loop locally — tool calls
// (Read/Edit/Bash/…) execute against the user's filesystem in `agent.cwd`.
//
// Session multi-turn: we mint our own local session ids up front (so the
// app's newSession flow returns something instantly), then capture the
// SDK-assigned session_id from the first SDKMessage and use it as `resume`
// on subsequent sends. Conversation transcripts are persisted in
// localTranscripts since there's no server-side event log.
//
// Permission model: 'bypassPermissions' for the MVP — no approval UX yet.
// A future pass should use the canUseTool callback to route through a
// renderer-side approval dialog.

import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import * as agentStore from "./agentStore";
import { resolveBundledClaudeBin } from "./claudeBin";
import * as localTranscripts from "./localTranscripts";
import type { AgentStreamEvent } from "./anthropic";
import { normalizeSdkMessage } from "./sdkEvents";
import type { AgentHistoryPage, AgentMsg, AssistantBlock, CreateAgentInput } from "../shared/types";

const LOCAL_AGENT_PREFIX = "local:";
const LOCAL_SESSION_PREFIX = "local-sess:";

export function isLocalAgentId(id: string): boolean {
  return id.startsWith(LOCAL_AGENT_PREFIX);
}

export function localSessionId(): string {
  return LOCAL_SESSION_PREFIX + crypto.randomUUID();
}

export interface CreatedLocalAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model: string;
  cwd: string;
}

export function createAgent(input: CreateAgentInput): CreatedLocalAgent {
  return {
    id: LOCAL_AGENT_PREFIX + crypto.randomUUID(),
    name: input.name,
    description: input.description,
    systemPrompt: input.systemPrompt,
    model: input.model ?? "claude-sonnet-4-6",
    cwd: input.cwd ?? os.homedir(),
  };
}

export function archiveSession(sessionId: string): void {
  localTranscripts.clear(sessionId);
}

export function loadSessionMessages(
  sessionId: string,
  // cursor is accepted to match the dispatcher's call shape but local
  // transcripts are stored in full, so there's only ever one page.
  _cursor?: string | null,
): AgentHistoryPage {
  void _cursor;
  return { msgs: localTranscripts.load(sessionId), nextCursor: null };
}

/** Mirrors the Claude Agent SDK's project-dir encoding for `~/.claude/projects/<dir>`.
 *  Replaces every non-alphanumeric character with '-'. Confirmed against the
 *  SDK at `@anthropic-ai/claude-agent-sdk` by inspecting the bundled regex. */
function sdkProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function sdkTranscriptExists(cwd: string, sdkSessionId: string): boolean {
  const file = path.join(
    os.homedir(),
    ".claude",
    "projects",
    sdkProjectDir(cwd),
    `${sdkSessionId}.jsonl`,
  );
  return fs.existsSync(file);
}

export async function sendMessage(
  sessionId: string,
  text: string,
  agent: agentStore.LocalAgent,
  onEvent: (e: AgentStreamEvent) => void,
  onSessionUnavailable?: () => void,
): Promise<void> {
  const cwd = agent.cwd ?? os.homedir();
  const persistedSdkId = agent.sessions.find((s) => s.id === sessionId)?.sdkSessionId;

  // If we have a saved SDK session id but its on-disk transcript is gone
  // (Claude Code pruned it, the cwd was renamed, or the user wiped
  // ~/.claude/projects), the session is no longer continuable. Archive it
  // rather than silently starting a fresh SDK session that the user would
  // mistake for a resumed one.
  if (persistedSdkId && !sdkTranscriptExists(cwd, persistedSdkId)) {
    archiveSession(sessionId);
    agentStore.removeSession(agent.id, sessionId);
    onSessionUnavailable?.();
    onEvent({
      kind: "error",
      message:
        "This session is no longer available — its underlying transcript was deleted. Start a new session to continue.",
    });
    return;
  }

  const resume = persistedSdkId;

  // Append user message to transcript up front so it persists even if the
  // stream fails mid-response.
  const history = localTranscripts.load(sessionId);
  const nextHistory: AgentMsg[] = [...history, { role: "user", text }];
  localTranscripts.save(sessionId, nextHistory);

  const assistant: Extract<AgentMsg, { role: "assistant" }> = {
    role: "assistant",
    blocks: [],
    phase: "Working…",
    done: false,
  };

  onEvent({ kind: "phase", label: "Working…" });

  const bundledBin = resolveBundledClaudeBin();
  const options: Options = {
    cwd,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    permissionMode: "bypassPermissions" as PermissionMode,
    allowDangerouslySkipPermissions: true,
    // Load the user's ~/.claude/settings.json so local agents inherit the same
    // MCP servers (and hooks) the terminal `claude` uses. Project/local scopes
    // are intentionally omitted: 'project' would pull CLAUDE.md and behave
    // differently per cwd, and 'local' is per-checkout state we don't want
    // leaking into agent runs.
    settingSources: ["user"],
    // In packaged builds the SDK's own resolver lands inside `app.asar`,
    // which spawn() can't traverse. See claudeBin.ts.
    ...(bundledBin ? { pathToClaudeCodeExecutable: bundledBin } : {}),
    ...(resume ? { resume } : {}),
  };

  try {
    const q = query({ prompt: text, options });

    let captured = persistedSdkId;
    for await (const msg of q) {
      // Persist the SDK's session id the first time we see it so resume works
      // on the next turn — including across app restarts.
      if (!captured && msg.session_id) {
        captured = msg.session_id;
        agentStore.setSessionSdkId(agent.id, sessionId, msg.session_id);
      }

      for (const e of normalizeSdkMessage(msg)) {
        onEvent(e);
        applyEventToAssistant(assistant, e);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ kind: "error", message });
    assistant.blocks.push({ kind: "text", text: `\n[error: ${message}]` });
  } finally {
    assistant.done = true;
    assistant.phase = null;
    localTranscripts.save(sessionId, [...nextHistory, assistant]);
  }
}

/** Mirrors the renderer's applyEvent so our persisted transcript matches
 *  what the user sees. */
function applyEventToAssistant(
  acc: Extract<AgentMsg, { role: "assistant" }>,
  e: AgentStreamEvent,
): void {
  // "thinking" is a transient spinner — pop it the moment real content lands
  // so persisted transcripts don't retain the indicator.
  if (
    acc.blocks[acc.blocks.length - 1]?.kind === "thinking" &&
    (e.kind === "text" || e.kind === "tool_use")
  ) {
    acc.blocks.pop();
  }
  const tail = acc.blocks[acc.blocks.length - 1];

  if (e.kind === "text") {
    if (tail?.kind === "text") {
      tail.text += e.text;
    } else {
      acc.blocks.push({ kind: "text", text: e.text });
    }
  } else if (e.kind === "thinking") {
    if (tail?.kind !== "thinking") acc.blocks.push({ kind: "thinking" });
  } else if (e.kind === "tool_use") {
    acc.blocks.push({
      kind: "tool_use",
      id: e.id,
      name: e.name,
      server: e.server,
      input: e.input,
      status: "running",
    });
  } else if (e.kind === "tool_result") {
    const block = acc.blocks.find(
      (b): b is Extract<AssistantBlock, { kind: "tool_use" }> =>
        b.kind === "tool_use" && b.id === e.toolUseId,
    );
    if (block) {
      block.status = e.isError ? "error" : "ok";
      block.resultSummary = e.summary;
    }
  } else if (e.kind === "phase") {
    acc.phase = e.label ?? null;
  }
}
