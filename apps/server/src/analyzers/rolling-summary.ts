import type { Analyzer, AnalyzerContext, AnalyzerResult } from "./types";
import { callStructured } from "./llm";
import { ROLLING_SUMMARY_ANALYZER } from "./names";
import type { events } from "../db/schema";
import { compactEvent, isNarrativeEvent } from "./event-compact";
import { MODELS } from "../models";
import {
  UNTRUSTED_INPUT_CONTRACT_ANALYZER,
  fenceUntrusted,
  promptHistoryLines,
  topJsonbEntries,
} from "./session-context";

const VERSION = "3";
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
        "3-5 sentences in present tense describing the session's overall goal and current approach — the feature/fix/refactor at the heart of the work.",
    },
    highlights: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
      description:
        "Up to 3 short bullets naming substantive code or product changes (new modules, refactors, behavior changes, files added/deleted, design decisions). Skip git plumbing, merges, commits, branch ops, and dev-server status.",
    },
  },
  required: ["summary", "highlights"],
};

export const ROLLING_SUMMARY_SYSTEM = `You narrate a coding session so a teammate glancing at a sidebar instantly gets the *point* of the work — the feature, fix, or refactor at the heart of the session, not the most recent keystroke.

summary: 3-5 present-tense sentences. Punchy verbs, concrete nouns. Name the file, the function, the bug, the approach being tried. Anchor on the session's goal — what is the developer building or fixing? — and use recent activity to flesh out *how* they're doing it, not to redirect the narrative.

Hard rules:
- Never narrate clock times or durations. Do not write "between 1:10 and 1:34" or "over the last N minutes".
- Never say "the user", "the developer", "Claude", or "the assistant". Describe the work itself, not who is doing it. ("Chasing a race in the WebSocket reconnect. Swapping exponential backoff in after the leaking-socket fix failed QA.")
- Do not count tool calls, tokens, files, or messages — those stats live elsewhere.
- Treat coda activity as backdrop, not headline: merging main, fast-forwarding commits, deleting branches, running tests, dev-server status, idling, "awaiting next task". The summary should still be about the substantive work.
- If a prior summary is given, evolve it — carry forward open threads. Only pivot when the developer has clearly moved on to a new substantive task.
- A late prompt is often a subtask, acknowledgement, review comment, or wrap-up request. Use the original task anchor and all-time file evidence to keep the narrative on the overall goal unless the prompt arc clearly starts something new.

highlights: up to 3 short bullets naming *substantive code or product changes* — a new module/component, a refactor, a behavior change, a file added or deleted, a design decision, a surprising finding, a failing test, an open question. Each bullet should describe *what changed in the codebase or product*, not what happened in git.

Do NOT highlight any of the following:
- merges, fast-forwards, commits pushed to main, branches created/deleted
- dev-server runs, type-check passes, lint runs
- idle time, paused state, "awaiting next task"
- routine edits already obvious from the summary

If you can't find 3 substantive code/product changes, return fewer bullets — or none. Empty highlights are better than filler.

${UNTRUSTED_INPUT_CONTRACT_ANALYZER}`;

export function buildPrompt(
  ctx: AnalyzerContext,
  recent: Array<typeof events.$inferSelect>,
  prior: RollingSummaryOutput | null,
): string {
  const s = ctx.session;
  const parts: string[] = [];
  if (prior) parts.push(`prior summary:\n${fenceUntrusted(prior.summary)}`);
  parts.push(`project: ${fenceUntrusted(s.project)}`);
  if (s.cwd) parts.push(`cwd: ${fenceUntrusted(s.cwd)}`);
  if (s.title) {
    parts.push(
      `original task anchor (first real user prompt; prefer this over late subtasks unless the session clearly pivoted):\n${fenceUntrusted(s.title)}`,
    );
  }
  const prompts = promptHistoryLines(s.recentPrompts, s.lastUserPrompt);
  if (prompts.length) {
    parts.push(
      `recent user prompts (oldest first; later entries may be subtasks or acknowledgements, not necessarily a new task):\n${fenceUntrusted(prompts.join("\n"))}`,
    );
  }

  const edited = topJsonbEntries(s.topFilesEdited, 5);
  const written = topJsonbEntries(s.topFilesWritten, 5);
  if (edited.length)
    parts.push(`top files edited (all-time):\n${fenceUntrusted(JSON.stringify(edited))}`);
  if (written.length)
    parts.push(`top files written (all-time):\n${fenceUntrusted(JSON.stringify(written))}`);

  const narrative = recent.filter(isNarrativeEvent);
  if (narrative.length) {
    const compact = narrative.map(compactEvent).join("\n");
    parts.push(`recent events (oldest first):\n${fenceUntrusted(compact)}`);
  } else if (Array.isArray(s.recentEvents) && s.recentEvents.length) {
    parts.push(
      `recent events (ring buffer):\n${fenceUntrusted(JSON.stringify(s.recentEvents).slice(0, 4000))}`,
    );
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
      system: ROLLING_SUMMARY_SYSTEM,
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
