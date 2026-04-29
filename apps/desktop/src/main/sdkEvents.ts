// Shared SDKMessage → AgentStreamEvent normalization. Used by both the
// managed-agent flow (localAgent.ts) and the chat-delegation flow
// (chatDelegate.ts) so they emit the same event shape into the renderer.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentStreamEvent } from "./anthropic";

/** SDKMessage → 0+ AgentStreamEvent. Handles the subset of SDK variants the
 *  renderer actually renders; unknown kinds fall through silently. Emits
 *  events without agentId — callers stamp it before broadcasting. */
export function normalizeSdkMessage(msg: SDKMessage): AgentStreamEvent[] {
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

export function summarizeToolResult(content: unknown): string | undefined {
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
