import type { Database } from "../db";
import type { events, sessionInsights, sessions } from "../db/schema";
import type { RedisBridge } from "../ws/redis-bridge";

export interface AnalyzerContext {
  db: Database;
  redis: RedisBridge;
  session: typeof sessions.$inferSelect;
  existingInsight: typeof sessionInsights.$inferSelect | null;
  /** Lazy fetcher: last ~30 events for this session, oldest-first. */
  recentEvents: () => Promise<Array<typeof events.$inferSelect>>;
}

export interface AnalyzerResult<T = unknown> {
  output: T;
  inputLineSeq: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  costUsd: number;
}

export interface Analyzer<TOutput = unknown> {
  name: string;
  version: string;
  model: string;
  shouldRun(ctx: AnalyzerContext): Promise<boolean>;
  run(ctx: AnalyzerContext): Promise<AnalyzerResult<TOutput>>;
}
