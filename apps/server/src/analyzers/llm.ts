import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

// Per-million-token USD pricing. Cache-write is computed as base × 1.25 (5m TTL).
const PRICING: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheRead: 0.1 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3 },
  "claude-opus-4-7": { in: 15, out: 75, cacheRead: 1.5 },
};

export interface StructuredCallParams {
  model: string;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: object;
  maxTokens?: number;
}

export interface StructuredCallResult<T> {
  output: T;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  costUsd: number;
}

export async function callStructured<T>(
  params: StructuredCallParams,
): Promise<StructuredCallResult<T>> {
  const resp = await client().messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 1024,
    system: [
      {
        type: "text",
        text: params.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: params.toolName,
        description: params.toolDescription,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: params.schema as any,
      },
    ],
    tool_choice: { type: "tool", name: params.toolName },
    messages: [{ role: "user", content: params.prompt }],
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("LLM response contained no tool_use block");
  }
  const output = toolUse.input as T;

  const usage = resp.usage;
  const tokensIn = usage.input_tokens ?? 0;
  const tokensOut = usage.output_tokens ?? 0;
  const tokensCacheRead = usage.cache_read_input_tokens ?? 0;
  const tokensCacheWrite = usage.cache_creation_input_tokens ?? 0;

  const pricing = PRICING[params.model] ?? { in: 1, out: 5, cacheRead: 0.1 };
  const costUsd =
    (tokensIn * pricing.in) / 1_000_000 +
    (tokensOut * pricing.out) / 1_000_000 +
    (tokensCacheRead * pricing.cacheRead) / 1_000_000 +
    (tokensCacheWrite * pricing.in * 1.25) / 1_000_000;

  return { output, tokensIn, tokensOut, tokensCacheRead, costUsd };
}
