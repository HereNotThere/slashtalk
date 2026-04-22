import { SessionState } from "@slashtalk/shared";

const HEARTBEAT_FRESH_S = 30;
const ACTIVE_WINDOW_S = 10;
const RECENT_WINDOW_S = 3600; // 1 hour

/**
 * Classify session state at read time.
 *
 * State machine:
 *   heartbeat fresh?
 *     yes → in_turn? → BUSY
 *            no → last event < 10s? → ACTIVE
 *                  no → IDLE
 *     no → last event < 1h? → RECENT
 *           no → ENDED
 */
export function classifySessionState(params: {
  heartbeatUpdatedAt: Date | null;
  inTurn: boolean;
  lastTs: Date | null;
  now?: Date;
}): SessionState {
  const now = params.now ?? new Date();
  const heartbeatFresh =
    params.heartbeatUpdatedAt != null &&
    (now.getTime() - params.heartbeatUpdatedAt.getTime()) / 1000 <
      HEARTBEAT_FRESH_S;

  if (heartbeatFresh) {
    if (params.inTurn) return SessionState.BUSY;
    if (
      params.lastTs &&
      (now.getTime() - params.lastTs.getTime()) / 1000 < ACTIVE_WINDOW_S
    ) {
      return SessionState.ACTIVE;
    }
    return SessionState.IDLE;
  }

  if (
    params.lastTs &&
    (now.getTime() - params.lastTs.getTime()) / 1000 < RECENT_WINDOW_S
  ) {
    return SessionState.RECENT;
  }

  return SessionState.ENDED;
}
