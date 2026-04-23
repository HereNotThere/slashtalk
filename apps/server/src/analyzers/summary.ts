import type { Analyzer, AnalyzerContext, AnalyzerResult } from "./types";
import { callStructured } from "./llm";
import { SUMMARY_ANALYZER } from "./names";

const MODEL = "claude-haiku-4-5-20251001";
const VERSION = "1";
const LINE_SEQ_REFRESH_DELTA = 200;
const REFRESH_MIN_MS = 10 * 60 * 1000;

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
        "5-8 word label for this session in sentence case, no ending period.",
    },
    description: {
      type: "string",
      description:
        "1-2 sentences describing the intent and current approach of the session.",
    },
  },
  required: ["title", "description"],
};

const SYSTEM = `You label live Claude Code sessions so teammates can see what each session is about.

Given session metadata (recent prompt, files being edited, tools used), emit a concise title and a 1-2 sentence description. Be specific to the technical work, not generic.

Good examples:
- title: "Refactoring Redis pub/sub for soft-fail"
- title: "Debugging WebSocket reconnect backoff"

Avoid vague labels like "Coding with Claude" or "Software development session".`;

function buildPrompt(ctx: AnalyzerContext): string {
  const s = ctx.session;
  const parts: string[] = [];
  parts.push(`project: ${s.project}`);
  if (s.cwd) parts.push(`cwd: ${s.cwd}`);
  if (s.branch) parts.push(`branch: ${s.branch}`);
  if (s.lastUserPrompt) {
    parts.push(`last user prompt:\n${s.lastUserPrompt}`);
  }

  const edited = Array.isArray(s.topFilesEdited) ? s.topFilesEdited.slice(0, 5) : [];
  const written = Array.isArray(s.topFilesWritten) ? s.topFilesWritten.slice(0, 5) : [];
  if (edited.length) parts.push(`top files edited: ${JSON.stringify(edited)}`);
  if (written.length) parts.push(`top files written: ${JSON.stringify(written)}`);

  const toolNames =
    s.toolUseNames && typeof s.toolUseNames === "object"
      ? Object.keys(s.toolUseNames as Record<string, unknown>).slice(0, 10)
      : [];
  if (toolNames.length) parts.push(`tools used: ${toolNames.join(", ")}`);

  return parts.join("\n\n");
}

export const summaryAnalyzer: Analyzer<SummaryOutput> = {
  name: SUMMARY_ANALYZER,
  version: VERSION,
  model: MODEL,

  async shouldRun(ctx) {
    const s = ctx.session;
    // Need at least one prompt to work from.
    if (!s.lastUserPrompt && (s.userMsgs ?? 0) === 0) return false;

    const existing = ctx.existingInsight;
    if (!existing) return true;
    if (existing.analyzerVersion !== VERSION) return true;

    const currentSeq = s.serverLineSeq ?? 0;
    const prevSeq = existing.inputLineSeq ?? 0;
    if (currentSeq - prevSeq < LINE_SEQ_REFRESH_DELTA) return false;

    const analyzedAt = existing.analyzedAt?.getTime() ?? 0;
    return Date.now() - analyzedAt >= REFRESH_MIN_MS;
  },

  async run(ctx): Promise<AnalyzerResult<SummaryOutput>> {
    const prompt = buildPrompt(ctx);
    const result = await callStructured<SummaryOutput>({
      model: MODEL,
      system: SYSTEM,
      prompt,
      toolName: "emit_summary",
      toolDescription:
        "Emit the title and 1-2 sentence description for this Claude Code session.",
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
