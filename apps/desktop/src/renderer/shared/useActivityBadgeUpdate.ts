import { useEffect, useState } from "react";

/**
 * Calculate the next time the activity badge should update.
 * E.g. "5m" doesn't change until it becomes "6m", which is in ~1 minute.
 * Returns milliseconds until the next significant change.
 */
function msUntilNextUpdate(lastActivityAtMs: number): number {
  const now = Date.now();
  const ageMs = Math.max(0, now - lastActivityAtMs);
  const ageSec = Math.floor(ageMs / 1000);
  const ageMin = Math.floor(ageSec / 60);
  const ageHr = Math.floor(ageMin / 60);

  // "now" (< 60s) — update every 5s to catch the transition
  if (ageSec < 60) return 5000;
  // "Xm" (60s to 60m) — update every minute
  if (ageMin < 60) return 60000 - (ageSec % 60) * 1000;
  // "Xh" (60m to 24h) — update every hour
  if (ageHr < 24) return 60 * 60 * 1000 - (ageMin % 60) * 60 * 1000;
  // "Xd" (24h+) — update every day
  return 24 * 60 * 60 * 1000 - (ageHr % 24) * 60 * 60 * 1000;
}

/**
 * Trigger a re-render at the next meaningful update time for an activity badge.
 * Automatically cleans up timers on unmount or when timestamp changes.
 */
export function useActivityBadgeUpdate(lastActivityAtMs: number | null): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (lastActivityAtMs == null) return;

    const schedule = (): ReturnType<typeof setTimeout> => {
      const delayMs = msUntilNextUpdate(lastActivityAtMs);
      return setTimeout(() => {
        setTick((t) => t + 1);
        schedule();
      }, delayMs);
    };

    const timer = schedule();
    return () => clearTimeout(timer);
  }, [lastActivityAtMs]);
}
