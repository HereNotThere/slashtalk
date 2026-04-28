// Single source of truth for Claude model IDs and per-million-token pricing.
// Keep in sync with CLAUDE.md rule #8 ("latest Claude model IDs only").

export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

interface ModelPricing {
  in: number;
  out: number;
  cacheRead: number;
}

// Per-million-token USD pricing. Cache-write is computed as base × 1.25 (5m TTL).
export const PRICING: Record<ModelId, ModelPricing> = {
  [MODELS.haiku]: { in: 1, out: 5, cacheRead: 0.1 },
  [MODELS.sonnet]: { in: 3, out: 15, cacheRead: 0.3 },
  [MODELS.opus]: { in: 15, out: 75, cacheRead: 1.5 },
};

export interface ModelUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Convert an Anthropic usage block to USD using `PRICING` for `model`.
 *  Returns 0 when `usage` is undefined so the caller doesn't have to gate. */
export function calculateCostUsd(model: ModelId, usage: ModelUsage | undefined): number {
  if (!usage) return 0;
  const pricing = PRICING[model];
  const tokensIn = usage.input_tokens ?? 0;
  const tokensOut = usage.output_tokens ?? 0;
  const tokensCacheRead = usage.cache_read_input_tokens ?? 0;
  const tokensCacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (tokensIn * pricing.in) / 1_000_000 +
    (tokensOut * pricing.out) / 1_000_000 +
    (tokensCacheRead * pricing.cacheRead) / 1_000_000 +
    (tokensCacheWrite * pricing.in * 1.25) / 1_000_000
  );
}
