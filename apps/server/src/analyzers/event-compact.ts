import type { events } from "../db/schema";

const MAX_SNIPPET = 200;

export function snippet(s: unknown, max = MAX_SNIPPET): string {
  if (typeof s !== "string") return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

type JsonObj = Record<string, unknown>;

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as JsonObj;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join(" ");
}

export function findBlock(content: unknown, type: string): JsonObj | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === "object" && (block as JsonObj).type === type) {
      return block as JsonObj;
    }
  }
  return null;
}

export function describeToolCall(block: JsonObj): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const input = block.input;
  if (!input || typeof input !== "object") return name;
  const i = input as JsonObj;
  if (typeof i.file_path === "string") return `${name}(${i.file_path})`;
  if (typeof i.path === "string") return `${name}(${i.path})`;
  if (typeof i.command === "string") return `${name}: ${snippet(i.command, 120)}`;
  if (typeof i.pattern === "string") return `${name}(/${snippet(i.pattern, 80)}/)`;
  if (typeof i.query === "string") return `${name}: ${snippet(i.query, 120)}`;
  if (typeof i.description === "string") return `${name}: ${snippet(i.description, 120)}`;
  if (typeof i.prompt === "string") return `${name}: ${snippet(i.prompt, 120)}`;
  return name;
}

export function describeToolResult(block: JsonObj): string {
  const isError = block.is_error === true;
  const content = block.content;
  const text =
    typeof content === "string" ? content : Array.isArray(content) ? extractText(content) : "";
  const snip = snippet(text, 140);
  if (isError) return `ERROR ${snip || "(no message)"}`;
  return snip || "(ok)";
}

export function compactEvent(e: typeof events.$inferSelect): string {
  const ts = e.ts ? new Date(e.ts).toISOString().slice(11, 19) : "";
  const payload = (e.payload ?? {}) as JsonObj;
  const message = (payload.message ?? {}) as JsonObj;
  const content = message.content;

  switch (e.kind) {
    case "user_msg": {
      const text = typeof content === "string" ? content : extractText(content);
      return `[${ts}] prompt: ${snippet(text, 240) || "(empty)"}`;
    }
    case "assistant_msg": {
      const text = extractText(content);
      const toolUse = findBlock(content, "tool_use");
      if (toolUse) {
        const toolDesc = describeToolCall(toolUse);
        return text
          ? `[${ts}] reply: ${snippet(text, 160)} → ${toolDesc}`
          : `[${ts}] → ${toolDesc}`;
      }
      return `[${ts}] reply: ${snippet(text, 240) || "(no text)"}`;
    }
    case "tool_result": {
      const block = findBlock(content, "tool_result");
      return block ? `[${ts}] result: ${describeToolResult(block)}` : `[${ts}] result`;
    }
    case "tool_call": {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      return `[${ts}] → ${name}`;
    }
    case "reasoning":
      return `[${ts}] (thinking)`;
    case "turn_start":
      return `[${ts}] turn begins`;
    case "turn_end":
      return `[${ts}] turn ends`;
    default:
      return `[${ts}] ${e.kind}`;
  }
}

export function isNarrativeEvent(e: typeof events.$inferSelect): boolean {
  return e.kind !== "token_usage" && e.kind !== "meta" && e.kind !== "system";
}
