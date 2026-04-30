// Past-24h cutoff for the dashboard routes (e.g. /api/users/:login/prs,
// /api/users/:login/standup, /api/repos/:owner/:name/overview). Tz-neutral
// rolling window — same boundary regardless of caller/target locale.

const DAY_MS = 24 * 60 * 60 * 1000;

export function windowStart(): Date {
  return new Date(Date.now() - DAY_MS);
}
