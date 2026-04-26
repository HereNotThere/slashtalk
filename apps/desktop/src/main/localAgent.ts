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

import {
  query,
  type Options,
  type SDKMessage,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import * as crypto from "node:crypto";
import os from "node:os";
import * as agentStore from "./agentStore";
import * as localTranscripts from "./localTranscripts";
import type { AgentStreamEvent } from "./anthropic";
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
  sdkSessionByLocal.delete(sessionId);
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

// Map from our local session id → SDK-assigned session_id. Populated on the
// first send; used as `resume` on subsequent sends so the SDK rehydrates the
// conversation from its on-disk transcript. In-memory only — if the app
// restarts, the mapping is lost and the next send starts a fresh SDK session.
// The visible transcript survives restarts via localTranscripts.
const sdkSessionByLocal = new Map<string, string>();

export async function sendMessage(
  sessionId: string,
  text: string,
  agent: agentStore.LocalAgent,
  onEvent: (e: AgentStreamEvent) => void,
): Promise<void> {
  const cwd = agent.cwd ?? os.homedir();
  const resume = sdkSessionByLocal.get(sessionId);

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
    ...(resume ? { resume } : {}),
  };

  try {
    const q = query({ prompt: text, options });

    for await (const msg of q) {
      // Cache the SDK's session id the first time we see it so resume works
      // on the next turn.
      if (!sdkSessionByLocal.has(sessionId) && msg.session_id) {
        sdkSessionByLocal.set(sessionId, msg.session_id);
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

/** SDKMessage → 0+ AgentStreamEvent. Handles the subset of SDK variants the
 *  renderer actually renders; unknown kinds fall through silently. Emits
 *  events without agentId — main/index.ts's handler stamps it before
 *  broadcasting to renderers, matching the anthropic.ts callback shape. */
function normalizeSdkMessage(msg: SDKMessage): AgentStreamEvent[] {
  const out: AgentStreamEvent[] = [];

  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        if (block.text) out.push({ kind: "text", text: block.text });
      } else if (block.type === "thinking") {
        out.push({ kind: "thinking" });
      } else if (block.type === "tool_use") {
        out.push({
          kind: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        out.push({ kind: "phase", label: `Running ${block.name}…` });
      }
    }
  } else if (msg.type === "user") {
    // The SDK echoes tool_result blocks back as synthetic user messages
    // (the agent's loop consumes them as context). Surface them so the UI
    // can flip the matching tool_use pill from running → ok/error.
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          (block as { type: string }).type === "tool_result"
        ) {
          const b = block as {
            tool_use_id: string;
            is_error?: boolean;
            content?: unknown;
          };
          out.push({
            kind: "tool_result",
            toolUseId: b.tool_use_id,
            isError: b.is_error,
            summary: summarizeToolResult(b.content),
          });
        }
      }
    }
  } else if (msg.type === "result") {
    // Terminal: push usage then done. Any assistant turn in progress is
    // considered complete.
    if (msg.usage) {
      out.push({
        kind: "usage",
        input: msg.usage.input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
      });
    }
    out.push({ kind: "phase", label: null });
    if (msg.subtype === "success") {
      out.push({
        kind: "done",
        stopReason: msg.stop_reason ?? undefined,
      });
    } else {
      out.push({
        kind: "error",
        message: msg.errors.join("\n") || `Agent run failed (${msg.subtype}).`,
      });
    }
  }

  return out;
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

function summarizeToolResult(content: unknown): string | undefined {
  if (content == null) return undefined;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              typeof c === "object" && c !== null && "text" in c
                ? String((c as { text?: unknown }).text ?? "")
                : "",
            )
            .filter(Boolean)
            .join("")
        : "";
  if (!text) return undefined;
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= 140 ? trimmed : trimmed.slice(0, 137) + "…";
}
