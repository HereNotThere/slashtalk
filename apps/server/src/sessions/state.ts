import { SessionState } from "@slashtalk/shared";

export const HEARTBEAT_FRESH_S = 30;
const ACTIVE_WINDOW_S = 30;
// Cap BUSY on event recency too: in_turn only flips false on an explicit end
// signal (Claude stop_reason=end_turn, Codex task_complete/turn_aborted), so
// a process killed mid-turn would otherwise pin BUSY forever as long as the
// heartbeat keeps firing.
const BUSY_WINDOW_S = 600; // 10 min
const RECENT_WINDOW_S = 3600; // 1 hour

/**
 * Classify session state at read time.
 *
 * State machine:
 *   heartbeat fresh?
 *     yes → in_turn AND last event < 10min? → BUSY
 *            no → last event < 30s? → ACTIVE
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
    (now.getTime() - params.heartbeatUpdatedAt.getTime()) / 1000 < HEARTBEAT_FRESH_S;

  if (heartbeatFresh) {
    const lastEventAgeS = params.lastTs
      ? (now.getTime() - params.lastTs.getTime()) / 1000
      : Infinity;
    if (params.inTurn && lastEventAgeS < BUSY_WINDOW_S) return SessionState.BUSY;
    if (lastEventAgeS < ACTIVE_WINDOW_S) return SessionState.ACTIVE;
    return SessionState.IDLE;
  }

  if (params.lastTs && (now.getTime() - params.lastTs.getTime()) / 1000 < RECENT_WINDOW_S) {
    return SessionState.RECENT;
  }

  return SessionState.ENDED;
}
