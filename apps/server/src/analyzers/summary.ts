import type { Analyzer, AnalyzerContext, AnalyzerResult } from "./types";
import { callStructured } from "./llm";
import { SUMMARY_ANALYZER } from "./names";
import type { events } from "../db/schema";
import { compactEvent, isNarrativeEvent } from "./event-compact";
import { MODELS } from "../models";

const VERSION = "2";
const LINE_SEQ_REFRESH_DELTA = 50;
const REFRESH_MIN_MS = 10 * 60 * 1000;
const MIN_EVENTS_FOR_FIRST_SUMMARY = 3;

interface SummaryOutput {
  title: string;
  description: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "5-8 word label for this session in sentence case, no ending period.",
    },
    description: {
      type: "string",
      description: "1-2 sentences describing the intent and current approach of the session.",
    },
  },
  required: ["title", "description"],
};

const SYSTEM = `You label live coding sessions so teammates can see what each session is about.

Given session metadata (recent prompts, files being edited, tools used, recent events), emit a concise title and a 1-2 sentence description. Be specific to the technical work, not generic.

Good examples:
- title: "Refactoring Redis pub/sub for soft-fail"
- title: "Debugging WebSocket reconnect backoff"

Avoid vague labels like "Coding session" or "Software development session".

The session evolves. Bias toward what's happening *now*: the most recent prompts and recent events outrank earlier activity. If a prior title is given, only keep it when the recent work is still about the same thing — otherwise pivot to reflect the current task. Don't stay anchored to the first prompt (e.g. "merging main") when the user has moved on.`;

function buildPrompt(
  ctx: AnalyzerContext,
  recent: Array<typeof events.$inferSelect>,
  prior: SummaryOutput | null,
): string {
  const s = ctx.session;
  const parts: string[] = [];
  if (prior) {
    parts.push(
      `prior title: ${prior.title}\nprior description: ${prior.description}\n(keep only if current work matches; otherwise pivot)`,
    );
  }
  parts.push(`project: ${s.project}`);
  if (s.cwd) parts.push(`cwd: ${s.cwd}`);
  if (s.branch) parts.push(`branch: ${s.branch}`);
  if (s.lastUserPrompt) {
    parts.push(`most recent user prompt:\n${s.lastUserPrompt}`);
  }

  const edited = Array.isArray(s.topFilesEdited) ? s.topFilesEdited.slice(0, 5) : [];
  const written = Array.isArray(s.topFilesWritten) ? s.topFilesWritten.slice(0, 5) : [];
  if (edited.length) parts.push(`top files edited (all-time): ${JSON.stringify(edited)}`);
  if (written.length) parts.push(`top files written (all-time): ${JSON.stringify(written)}`);

  const toolNames =
    s.toolUseNames && typeof s.toolUseNames === "object"
      ? Object.keys(s.toolUseNames as Record<string, unknown>).slice(0, 10)
      : [];
  if (toolNames.length) parts.push(`tools used (all-time): ${toolNames.join(", ")}`);

  const narrative = recent.filter(isNarrativeEvent);
  if (narrative.length) {
    const compact = narrative.map(compactEvent).join("\n");
    parts.push(`recent events (oldest first — these reflect current work):\n${compact}`);
  }

  return parts.join("\n\n");
}

export const summaryAnalyzer: Analyzer<SummaryOutput> = {
  name: SUMMARY_ANALYZER,
  version: VERSION,
  model: MODELS.haiku,

  async shouldRun(ctx) {
    const s = ctx.session;
    const existing = ctx.existingInsight;
    const totalEvents = s.events ?? 0;

    if (!existing) {
      if (!s.lastUserPrompt && (s.userMsgs ?? 0) === 0) return false;
      return totalEvents >= MIN_EVENTS_FOR_FIRST_SUMMARY;
    }
    if (existing.analyzerVersion !== VERSION) return true;

    const currentSeq = s.serverLineSeq ?? 0;
    const prevSeq = existing.inputLineSeq ?? 0;
    if (currentSeq - prevSeq >= LINE_SEQ_REFRESH_DELTA) return true;

    const analyzedAt = existing.analyzedAt?.getTime() ?? 0;
    return Date.now() - analyzedAt >= REFRESH_MIN_MS && currentSeq > prevSeq;
  },

  async run(ctx): Promise<AnalyzerResult<SummaryOutput>> {
    const recent = await ctx.recentEvents();
    const prior = (ctx.existingInsight?.output as SummaryOutput | undefined) ?? null;
    const prompt = buildPrompt(ctx, recent, prior);
    const result = await callStructured<SummaryOutput>({
      model: MODELS.haiku,
      system: SYSTEM,
      prompt,
      toolName: "emit_summary",
      toolDescription: "Emit the title and 1-2 sentence description for this coding session.",
      schema: SCHEMA,
      maxTokens: 300,
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
