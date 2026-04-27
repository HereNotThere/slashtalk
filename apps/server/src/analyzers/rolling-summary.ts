import type { Analyzer, AnalyzerContext, AnalyzerResult } from "./types";
import { callStructured } from "./llm";
import { ROLLING_SUMMARY_ANALYZER } from "./names";
import type { events } from "../db/schema";
import { compactEvent, isNarrativeEvent } from "./event-compact";
import { MODELS } from "../models";

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
      description: "3-5 sentences in present tense narrating what is happening in this session.",
    },
    highlights: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
      description: "Up to 3 short bullets capturing recent key moments or open loops.",
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

  const edited = Array.isArray(s.topFilesEdited) ? s.topFilesEdited.slice(0, 5) : [];
  if (edited.length) parts.push(`top files edited: ${JSON.stringify(edited)}`);

  const narrative = recent.filter(isNarrativeEvent);
  if (narrative.length) {
    const compact = narrative.map(compactEvent).join("\n");
    parts.push(`recent events (oldest first):\n${compact}`);
  } else if (Array.isArray(s.recentEvents) && s.recentEvents.length) {
    parts.push(`recent events (ring buffer):\n${JSON.stringify(s.recentEvents).slice(0, 4000)}`);
  }

  return parts.join("\n\n");
}

export const rollingSummaryAnalyzer: Analyzer<RollingSummaryOutput> = {
  name: ROLLING_SUMMARY_ANALYZER,
  version: VERSION,
  model: MODELS.haiku,

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
    return Date.now() - analyzedAt >= REFRESH_INTERVAL_MS && currentSeq > prevSeq;
  },

  async run(ctx): Promise<AnalyzerResult<RollingSummaryOutput>> {
    const recent = await ctx.recentEvents();
    const prior = (ctx.existingInsight?.output as RollingSummaryOutput | undefined) ?? null;
    const prompt = buildPrompt(ctx, recent, prior);
    const result = await callStructured<RollingSummaryOutput>({
      model: MODELS.haiku,
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
