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

const SYSTEM = `You narrate live Claude Code sessions for teammates watching ambient presence.

Given the session state, prior narrative (if any), and recent events, emit:
- summary: 3-5 present-tense sentences. Describe what is being done and tried. No hedging, no filler.
- highlights: up to 3 short bullets of recent interesting moments or open questions.

Write tight. Assume the reader is another engineer.`;

function compactEvent(e: typeof events.$inferSelect): string {
  const ts = e.ts ? new Date(e.ts).toISOString().slice(11, 19) : "";
  const call = e.callId ? ` call=${e.callId}` : "";
  const turn = e.turnId ? ` turn=${e.turnId.slice(0, 8)}` : "";
  return `${ts} ${e.kind}${call}${turn}`;
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

  if (recent.length) {
    const compact = recent.slice(-30).map(compactEvent).join("\n");
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
