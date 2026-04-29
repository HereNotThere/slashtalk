// Time-window cutoffs for "today" and "past 24h" routes (e.g. /api/users/:login/prs,
// /api/users/:login/standup). "today" is computed in the target user's IANA
// timezone — falling back to UTC when the user has no recorded tz — so a user
// in Asia sees their local day boundary, not the server's.

import type { DashboardScope } from "@slashtalk/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the UTC instant marking the start of the requested window. Callers
// pass `scope` ("today" => today's 00:00 in `tz`; "past24h" => now - 24h) and
// the user's IANA tz (or null). Invalid tz silently falls back to UTC — same
// posture as the rest of the codebase, where unknown locale just means a less
// localized boundary, not an error.
export function windowStart(scope: DashboardScope, tz: string | null): Date {
  if (scope === "past24h") {
    return new Date(Date.now() - DAY_MS);
  }
  return startOfTodayInTz(tz);
}

function startOfTodayInTz(tz: string | null): Date {
  const now = new Date();
  if (!tz) return startOfUtcDay(now);
  // Read the wall-clock parts in the user's tz, then build an ISO string at
  // 00:00 in that tz and convert back to a UTC instant. Done with two
  // formatter passes: one to extract y/m/d in tz, one to find the UTC offset
  // applicable at that local midnight (DST-aware).
  let parts: { year: string; month: string; day: string };
  try {
    parts = ymdInTz(now, tz);
  } catch {
    return startOfUtcDay(now);
  }
  const localMidnightUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    0,
    0,
    0,
    0,
  );
  // Compute the offset (minutes east of UTC) that the tz had at that local
  // midnight by formatting the tentative UTC instant back into the tz and
  // measuring drift. Iterate once: DST-transition days can shift the offset
  // by an hour, so a single correction is enough for IANA zones.
  const offsetMs = tzOffsetAt(localMidnightUtc, tz);
  return new Date(localMidnightUtc - offsetMs);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function ymdInTz(d: Date, tz: string): { year: string; month: string; day: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

// Returns the tz's offset (UTC - tzWall) in ms at the given UTC instant.
// Computed by reading wall-clock parts in tz and subtracting from the input.
function tzOffsetAt(utcMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Intl returns hour=24 for midnight in some locales; normalize to 0.
  const hour = get("hour") % 24;
  const wallUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
    0,
  );
  return wallUtc - utcMs;
}
