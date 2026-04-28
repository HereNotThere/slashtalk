import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { calculateCostUsd, type ModelId } from "../models";
import type { RedisBridge } from "../ws/redis-bridge";
import { LlmBudgetExceededError, checkLlmBudget, recordLlmSpend } from "./llm-budget";

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

export interface StructuredCallParams {
  model: ModelId;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: object;
  maxTokens?: number;
  /** Required for budget enforcement. The session owner pays for analyzer
   *  calls; the chat caller pays for chat-agent calls. Pass the Redis bridge
   *  so we can read/write the per-day counter. */
  budget: { redis: RedisBridge; userId: number };
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
  const budget = await checkLlmBudget(params.budget.redis, params.budget.userId);
  if (!budget.allowed) {
    throw new LlmBudgetExceededError(params.budget.userId, budget.spentUsd, budget.capUsd);
  }
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
  const costUsd = calculateCostUsd(params.model, usage);

  await recordLlmSpend(params.budget.redis, params.budget.userId, costUsd);

  return { output, tokensIn, tokensOut, tokensCacheRead, costUsd };
}
