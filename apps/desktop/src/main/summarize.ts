// Generates a short, human-readable recap of a managed-agent session.
//
// Pulls events via client.beta.sessions.events.list(sessionId) — Anthropic
// retains them indefinitely, so we don't need to store the raw transcript
// on our side. Compacts user/agent messages + tool uses into a lightweight
// transcript, then asks Haiku for a 2-3 sentence summary. Plain-text output
// lands in agent_sessions.summary.

import * as anthropic from "./anthropic";

const SUMMARY_MODEL = "claude-haiku-4-5";
// Safety cap: long conversations are rare but we don't want to balloon the
// prompt + cost for an unbounded session.
const MAX_EVENTS = 200;
const MAX_TOOL_INPUT_CHARS = 200;

const SYSTEM_PROMPT = `You are summarizing a managed-agent conversation for a teammate who wasn't in the loop.
Given the events below, write a 2-3 sentence recap in plain prose (no bullets, no headings) that captures:
- what the user asked the agent to do,
- the key actions the agent took (major tool calls or decisions),
- the outcome.
Keep it under 70 words. If the conversation is empty or trivially short, return exactly:
"Session ended with no meaningful activity."`;

const EMPTY_SUMMARY = "Session ended with no meaningful activity.";

export async function summarizeCloudSession(
  sessionId: string,
): Promise<{ summary: string; model: string }> {
  const client = anthropic.getClient();

  const events: Array<Record<string, unknown>> = [];
  for await (const ev of client.beta.sessions.events.list(sessionId)) {
    events.push(ev as unknown as Record<string, unknown>);
    if (events.length >= MAX_EVENTS) break;
  }

  const transcript = compact(events);
  if (!transcript) {
    return { summary: EMPTY_SUMMARY, model: SUMMARY_MODEL };
  }

  const resp = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: transcript }],
  });

  const text = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();

  return { summary: text || EMPTY_SUMMARY, model: SUMMARY_MODEL };
}

function compact(events: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const e of events) {
    const type = e["type"];
    if (type === "user.message") {
      const content = extractText(e["content"]);
      if (content) lines.push(`USER: ${content}`);
    } else if (type === "agent.message") {
      const content = extractText(e["content"]);
      if (content) lines.push(`AGENT: ${content}`);
    } else if (type === "agent.tool_use") {
      const name = typeof e["name"] === "string" ? e["name"] : "unknown";
      const input = safeStringify(e["input"]);
      lines.push(`TOOL_USE[${name}] ${input}`);
    }
    // thinking / status / error / other event kinds are noise for the recap.
  }
  return lines.join("\n");
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ) {
      parts.push((b as { text: string }).text);
    }
  }
  return parts.join(" ").trim();
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (!s) return "";
    return s.length > MAX_TOOL_INPUT_CHARS
      ? s.slice(0, MAX_TOOL_INPUT_CHARS) + "…"
      : s;
  } catch {
    return "";
  }
}
