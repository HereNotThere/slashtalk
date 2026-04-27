import type { RedisBridge } from "../ws/redis-bridge";

export interface InsightsUpdatedPayload {
  type: "session_insights_updated";
  session_id: string;
  repo_id: number;
  analyzer: string;
  output: unknown;
  analyzed_at: string;
}

export function publishInsightsUpdate(
  redis: RedisBridge,
  sessionId: string,
  repoId: number,
  analyzer: string,
  output: unknown,
  analyzedAt: Date,
): void {
  const payload: InsightsUpdatedPayload = {
    type: "session_insights_updated",
    session_id: sessionId,
    repo_id: repoId,
    analyzer,
    output,
    analyzed_at: analyzedAt.toISOString(),
  };
  void redis.publish(`repo:${repoId}`, payload);
}
