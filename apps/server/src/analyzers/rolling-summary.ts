import type { Analyzer, AnalyzerContext, AnalyzerResult } from "./types";
import { callStructured } from "./llm";
import { ROLLING_SUMMARY_ANALYZER } from "./names";
import type { events } from "../db/schema";

const MODEL = "claude-haiku-4-5-20251001";
const VERSION = "1";
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const LINE_SEQ_DELTA = 50;
const MIN_EVENTS_FOR_FIRST_SUMMARY = 5;

interface RollingSummaryOutput {
  summary: string;
  highlights: string[];
}

const SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "3-5 sentences in present tense narrating what is happening in this session.",
    },
    highlights: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
      description:
        "Up to 3 short bullets capturing recent key moments or open loops.",
    },
  },
  required: ["summary", "highlights"],
};

const SYSTEM = `You narrate a live coding session so a teammate glancing at a sidebar instantly gets what's going on.

summary: 3-5 present-tense sentences. Punchy verbs, concrete nouns. Name the file, the function, the bug, the approach being tried. Show momentum — what was just attempted, what's happening now, what's stuck.

Hard rules:
- Never narrate clock times or durations. Do not write "between 1:10 and 1:34" or "over the last N minutes".
- Never say "the user", "the developer", "Claude", or "the assistant". Describe the work itself, not who is doing it. ("Chasing a race in the WebSocket reconnect. Swapping exponential backoff in after the leaking-socket fix failed QA.")
- Do not count tool calls, tokens, files, or messages — those stats live elsewhere.
- If a prior summary is given, evolve it — carry forward open threads, don't restart from scratch.

highlights: up to 3 short bullets — a surprising finding, a failing test, a pivot, an open question. Skip routine edits and anything already obvious from the summary.`;

const MAX_SNIPPET = 200;

function snippet(s: unknown, max = MAX_SNIPPET): string {
  if (typeof s !== "string") return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

type JsonObj = Record<string, unknown>;

function extractText(content: unknown): string {
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

function findBlock(content: unknown, type: string): JsonObj | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as JsonObj).type === type
    ) {
      return block as JsonObj;
    }
  }
  return null;
}

function describeToolCall(block: JsonObj): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const input = block.input;
  if (!input || typeof input !== "object") return name;
  const i = input as JsonObj;
  if (typeof i.file_path === "string") return `${name}(${i.file_path})`;
  if (typeof i.path === "string") return `${name}(${i.path})`;
  if (typeof i.command === "string") return `${name}: ${snippet(i.command, 120)}`;
  if (typeof i.pattern === "string") return `${name}(/${snippet(i.pattern, 80)}/)`;
  if (typeof i.query === "string") return `${name}: ${snippet(i.query, 120)}`;
  if (typeof i.description === "string")
    return `${name}: ${snippet(i.description, 120)}`;
  if (typeof i.prompt === "string") return `${name}: ${snippet(i.prompt, 120)}`;
  return name;
}

function describeToolResult(block: JsonObj): string {
  const isError = block.is_error === true;
  const content = block.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? extractText(content)
        : "";
  const snip = snippet(text, 140);
  if (isError) return `ERROR ${snip || "(no message)"}`;
  return snip || "(ok)";
}

function compactEvent(e: typeof events.$inferSelect): string {
  const ts = e.ts ? new Date(e.ts).toISOString().slice(11, 19) : "";
  const payload = (e.payload ?? {}) as JsonObj;
  const message = (payload.message ?? {}) as JsonObj;
  const content = message.content;

  switch (e.kind) {
    case "user_msg": {
      const text =
        typeof content === "string" ? content : extractText(content);
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
      return block
        ? `[${ts}] result: ${describeToolResult(block)}`
        : `[${ts}] result`;
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

function buildPrompt(
  ctx: AnalyzerContext,
  recent: Array<typeof events.$inferSelect>,
  prior: RollingSummaryOutput | null,
): string {
  const s = ctx.session;
  const parts: string[] = [];
  if (prior) parts.push(`prior summary:\n${prior.summary}`);
  parts.push(`project: ${s.project}`);
  if (s.cwd) parts.push(`cwd: ${s.cwd}`);
  if (s.lastUserPrompt) {
    parts.push(`most recent user prompt:\n${s.lastUserPrompt}`);
  }

  const edited = Array.isArray(s.topFilesEdited)
    ? s.topFilesEdited.slice(0, 5)
    : [];
  if (edited.length) parts.push(`top files edited: ${JSON.stringify(edited)}`);

  const narrative = recent.filter(
    (e) => e.kind !== "token_usage" && e.kind !== "meta" && e.kind !== "system",
  );
  if (narrative.length) {
    const compact = narrative.map(compactEvent).join("\n");
    parts.push(`recent events (oldest first):\n${compact}`);
  } else if (Array.isArray(s.recentEvents) && s.recentEvents.length) {
    parts.push(
      `recent events (ring buffer):\n${JSON.stringify(s.recentEvents).slice(0, 4000)}`,
    );
  }

  return parts.join("\n\n");
}

export const rollingSummaryAnalyzer: Analyzer<RollingSummaryOutput> = {
  name: ROLLING_SUMMARY_ANALYZER,
  version: VERSION,
  model: MODEL,

  async shouldRun(ctx) {
    const s = ctx.session;
    const existing = ctx.existingInsight;
    const totalEvents = s.events ?? 0;

    if (!existing) {
      return totalEvents >= MIN_EVENTS_FOR_FIRST_SUMMARY;
    }
    if (existing.analyzerVersion !== VERSION) return true;

    const currentSeq = s.serverLineSeq ?? 0;
    const prevSeq = existing.inputLineSeq ?? 0;
    if (currentSeq - prevSeq >= LINE_SEQ_DELTA) return true;

    const analyzedAt = existing.analyzedAt?.getTime() ?? 0;
    return (
      Date.now() - analyzedAt >= REFRESH_INTERVAL_MS && currentSeq > prevSeq
    );
  },

  async run(ctx): Promise<AnalyzerResult<RollingSummaryOutput>> {
    const recent = await ctx.recentEvents();
    const prior =
      (ctx.existingInsight?.output as RollingSummaryOutput | undefined) ??
      null;
    const prompt = buildPrompt(ctx, recent, prior);
    const result = await callStructured<RollingSummaryOutput>({
      model: MODEL,
      system: SYSTEM,
      prompt,
      toolName: "emit_rolling_summary",
      toolDescription: "Emit a rolling narrative summary for this live session.",
      schema: SCHEMA,
      maxTokens: 600,
    });
    return {
      output: result.output,
      inputLineSeq: ctx.session.serverLineSeq ?? 0,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      tokensCacheRead: result.tokensCacheRead,
      costUsd: result.costUsd,
    };
  },
};
