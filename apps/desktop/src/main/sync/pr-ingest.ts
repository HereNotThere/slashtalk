// Proactive ingestion of the signed-in user's own PRs into the server's
// `pull_requests` table. Without this, the project info-card stays empty
// until the user happens to hover their own user-card (which is what fires
// the lazy `pushSelfPrs` from windows/info.ts) — fine for power users,
// confusing for everyone else who opens the project card on app launch and
// sees "Quiet window" despite having open PRs.
//
// Flow per tick:
//   gh CLI search (caller's authored PRs, scope=today)
//     → POST /v1/me/prs (server upserts into pull_requests)
//
// Soft-fail at every step: gh missing/unauthed → no-op; server 4xx/5xx →
// log + retry on next tick. Mirrors the posture of windows/info.ts's
// hover-driven path so the two stay consistent.

import type { DashboardScope } from "@slashtalk/shared";
import * as backend from "../backend";
import { fetchGhUserPrs, type GhPr } from "../ghPrs";

// 5 min cadence. Same TTL as the server-side standup cache, so the next
// hover after a tick lands on a fresh blurb. Shorter and we'd burn the
// gh CLI for no user-visible win; longer and the empty-card window grows.
const POLL_MS = 5 * 60 * 1000;

const SCOPE: DashboardScope = "today";

let running = false;
let timer: NodeJS.Timeout | null = null;
// Fingerprint of the last successfully-pushed PR set. Skip the network
// roundtrip when nothing changed since the previous tick — a steady-state
// repo with N open PRs and no edits would otherwise re-upsert the same N
// rows every 5 minutes for no observable effect. Cleared on stop() so a
// fresh sign-in always pushes its first batch.
let lastFingerprint: string | null = null;

function fingerprintPrs(prs: GhPr[]): string {
  // Sort by (repoFullName, number) so input order doesn't affect the hash.
  // PR numbers aren't unique across repos, so without the repoFullName
  // tiebreak the relative order of e.g. owner-a/r#1 and owner-b/r#1 would
  // depend on whatever order GitHub's GraphQL search returned them — which
  // can vary across calls and silently defeat the skip-when-unchanged
  // optimization.
  const sorted = [...prs].sort(
    (a, b) => a.repoFullName.localeCompare(b.repoFullName) || a.number - b.number,
  );
  return sorted
    .map(
      (p) =>
        `${p.repoFullName}#${p.number}:${p.state}:${p.updatedAt}:${p.headRef}:${p.title.length}`,
    )
    .join("|");
}

async function refresh(): Promise<void> {
  if (!running) return;
  const state = backend.getAuthState();
  if (!state.signedIn) return;
  const login = state.user.githubLogin;

  let prs;
  try {
    const result = await fetchGhUserPrs(login, SCOPE);
    if (result.ghStatus !== "ready") return;
    prs = result.prs;
  } catch (err) {
    console.warn("[prIngest] gh fetch failed:", (err as Error).message);
    return;
  }
  if (prs.length === 0) return;

  const fp = fingerprintPrs(prs);
  if (fp === lastFingerprint) return;

  try {
    const r = await backend.pushSelfPrs(prs);
    lastFingerprint = fp;
    if (r.upserted > 0) {
      console.log(
        `[prIngest] pushed ${r.upserted} self PR(s) to server (${r.unknownRepos} unknown repo)`,
      );
    }
  } catch (err) {
    console.warn("[prIngest] pushSelfPrs failed:", (err as Error).message);
    // Leave lastFingerprint untouched so the next tick retries.
  }
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  // Don't await: a slow first refresh shouldn't block the rest of the
  // sign-in sync (uploader, heartbeat, ws). The renderer can paint while
  // this lands in the background.
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
}

/** Invalidate the fingerprint and refresh on the next tick boundary. The
 *  PR set itself may not have changed (gh CLI ignores server-side claims),
 *  but if a *repo* was just claimed, PRs the server previously discarded
 *  as `unknownRepos` will now upsert successfully. Hook into claim events
 *  so the project card lights up on the very next hover. */
export function refreshNow(): void {
  lastFingerprint = null;
  void refresh();
}

export function stop(): void {
  if (!running) return;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // A different user may sign in next; clear so their first refresh always
  // pushes regardless of fingerprint coincidences across logins.
  lastFingerprint = null;
}
