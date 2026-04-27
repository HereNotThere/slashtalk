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
