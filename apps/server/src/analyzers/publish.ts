import type { SessionInsightsUpdatedMessage } from "@slashtalk/shared";
import type { RedisBridge } from "../ws/redis-bridge";

export function publishInsightsUpdate(
  redis: RedisBridge,
  sessionId: string,
  repoId: number,
  analyzer: string,
  output: unknown,
  analyzedAt: Date,
): void {
  const payload: SessionInsightsUpdatedMessage = {
    type: "session_insights_updated",
    session_id: sessionId,
    repo_id: repoId,
    analyzer,
    output,
    analyzed_at: analyzedAt.toISOString(),
  };
  void redis.publish(`repo:${repoId}`, payload);
}
