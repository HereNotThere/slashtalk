import { config } from "../config";
import type { RedisBridge } from "../ws/redis-bridge";

/**
 * Per-user, per-calendar-day spend ceiling for LLM calls (analyzers + chat).
 * The cost is logged after every call but nothing previously gated *on* it;
 * a runaway analyzer or a hostile session could rack up unbounded Anthropic
 * spend before anyone noticed. This module records spend in Redis under a
 * key that auto-expires the day after the spend happened, and short-circuits
 * the call before it hits the Anthropic SDK once the cap is reached.
 *
 * Soft-fail when Redis is down: we admit the call (`allowed: true`) so a
 * Redis outage doesn't take down all LLM features. The recorded spend is
 * also a no-op in that state, so we lose accounting for the duration —
 * acceptable, since we'd rather degrade visibility than block users on
 * infra that's already broken.
 */

const TTL_SECONDS = 25 * 60 * 60; // a bit over a day — covers DST / clock skew

export const SPEND_KEY_PREFIX = "llm:spend";
export const ERROR_CODE_BUDGET_EXCEEDED = "llm_budget_exceeded";

// Day boundaries are UTC. A user at UTC-5 sees the budget reset on UTC
// midnight rather than their local midnight; this avoids per-user
// timezone bookkeeping. The 25-hour TTL covers DST and clock skew so a
// stale counter never lingers visible past one full day.
const key = (userId: number, day: string): string => `${SPEND_KEY_PREFIX}:${userId}:${day}`;

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export class LlmBudgetExceededError extends Error {
  readonly code = ERROR_CODE_BUDGET_EXCEEDED;
  constructor(
    public readonly userId: number,
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `LLM daily budget exceeded for user ${userId}: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`,
    );
    this.name = "LlmBudgetExceededError";
  }
}

export interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  capUsd: number;
}

/** Read the current spend and decide whether the next call is admitted.
 *  When the cap is 0 the budget is disabled and every call is admitted. */
export async function checkLlmBudget(redis: RedisBridge, userId: number): Promise<BudgetCheck> {
  const capUsd = config.llmDailyBudgetUsd;
  if (!capUsd || capUsd <= 0) {
    return { allowed: true, spentUsd: 0, capUsd: 0 };
  }
  const spentUsd = await redis.getFloat(key(userId, todayUtc()));
  return { allowed: spentUsd < capUsd, spentUsd, capUsd };
}

/** Record the cost of a completed LLM call. Soft-fails when Redis is down. */
export async function recordLlmSpend(
  redis: RedisBridge,
  userId: number,
  costUsd: number,
): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  await redis.incrFloat(key(userId, todayUtc()), costUsd, TTL_SECONDS);
}
