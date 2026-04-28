import type { Analyzer, AnalyzerContext, AnalyzerResult } from "./types";
import { callStructured } from "./llm";
import { SUMMARY_ANALYZER } from "./names";
import type { events } from "../db/schema";
import { compactEvent, isNarrativeEvent } from "./event-compact";
import { MODELS } from "../models";
import {
  UNTRUSTED_INPUT_CONTRACT_ANALYZER,
  fenceUntrusted,
  promptHistoryLines,
  topJsonbEntries,
} from "./session-context";

const VERSION = "4";
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
      description:
        "5-8 word label naming the session's overall goal (the feature, fix, or refactor) in sentence case, no ending period.",
    },
    description: {
      type: "string",
      description:
        "1-2 sentences describing what the developer set out to accomplish in this session and how they're approaching it.",
    },
  },
  required: ["title", "description"],
};

export const SUMMARY_SYSTEM = `You label a coding session by its overall *goal* — what the developer set out to accomplish — so a teammate glancing at the card understands the point of the work, not the most recent keystroke.

Given session metadata (user prompts, files edited, tools used, recent events), emit a concise title and a 1-2 sentence description focused on the *substantive* feature, fix, or refactor at the heart of the session. Be specific to the technical work, not generic.

Good examples:
- title: "Refactoring Redis pub/sub for soft-fail"
- title: "Debugging WebSocket reconnect backoff"
- title: "Adding self-bubble timestamps to chat UI"

Avoid vague labels like "Coding session" or "Software development session".

Use the original task anchor and the prompt arc to identify the goal. A late prompt is often a subtask, acknowledgement, review comment, or wrap-up request; do not promote it to the title unless it clearly starts a new substantive task. All-time edited/written files usually describe the real work better than the last prompt.

What is *not* the goal — treat these as coda, never as the title:
- merging main, fast-forwarding commits, deleting branches
- running tests, type-checks, dev servers
- waiting, idling, or "awaiting next task"
- post-merge cleanup, branch hygiene

If the only signals you have are coda activity, infer the goal from the work that *led* to the merge — the user prompts that originally drove the session, the files that were actually edited, the prior title if one exists. The prior title is usually right; only replace it when the user has clearly pivoted to a *new substantive task*, not when they've finished one and moved into wrap-up.

${UNTRUSTED_INPUT_CONTRACT_ANALYZER}`;

export function buildPrompt(
  ctx: AnalyzerContext,
  recent: Array<typeof events.$inferSelect>,
  prior: SummaryOutput | null,
): string {
  const s = ctx.session;
  const parts: string[] = [];
  if (prior) {
    parts.push(
      `prior title and description (keep unless the developer has clearly moved on to a new substantive task — coda activity like merging or running tests is not a pivot):\n${fenceUntrusted(`title: ${prior.title}\ndescription: ${prior.description}`)}`,
    );
  }
  parts.push(`project: ${fenceUntrusted(s.project)}`);
  if (s.cwd) parts.push(`cwd: ${fenceUntrusted(s.cwd)}`);
  if (s.branch) parts.push(`branch: ${fenceUntrusted(s.branch)}`);
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

  const toolNames =
    s.toolUseNames && typeof s.toolUseNames === "object"
      ? Object.keys(s.toolUseNames as Record<string, unknown>).slice(0, 10)
      : [];
  if (toolNames.length) parts.push(`tools used (all-time): ${toolNames.join(", ")}`);

  const narrative = recent.filter(isNarrativeEvent);
  if (narrative.length) {
    const compact = narrative.map(compactEvent).join("\n");
    parts.push(
      `recent events (oldest first — these reflect current work):\n${fenceUntrusted(compact)}`,
    );
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
      system: SUMMARY_SYSTEM,
      prompt,
      toolName: "emit_summary",
      toolDescription: "Emit the title and 1-2 sentence description for this coding session.",
      schema: SCHEMA,
      maxTokens: 300,
      budget: { redis: ctx.redis, userId: ctx.session.userId },
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
