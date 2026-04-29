import * as backend from "../backend";
import * as rail from "../rail";
import * as uploader from "../uploader";
import * as ws from "../ws";
import * as info from "../windows/info";
import { broadcast } from "../windows/broadcast";
import { getMainWindow } from "../windows/main";
import type { InfoSession } from "../../shared/types";

/** Refresh the peer's session cache, then mark a collision only if at least
 *  one live (non-ENDED) session of theirs has the file in topFilesEdited or
 *  topFilesWritten — the same predicate the popover uses to render the
 *  in-row warning. Single source of truth: ring + warning live and die
 *  together. Used by both the WS path (production) and the debug picker. */
export async function verifyAndMarkCollision(login: string, filePath: string): Promise<void> {
  const headId = rail.userHeadId(login);
  // Drop the cache so we re-fetch with the latest topFiles. The server fires
  // collision_detected after session_updated but the WS messages can arrive
  // out of order or before our fetch completes; an explicit refresh
  // guarantees we see the post-update aggregates.
  info.invalidateSessionCache(headId);
  let sessions: InfoSession[];
  try {
    sessions = await info.fetchSessionsForHead(headId);
  } catch (err) {
    console.warn(`[collision] verify failed to fetch sessions for ${login}:`, err);
    return;
  }
  if (!anyLiveSessionTouchesFile(sessions, filePath)) {
    console.warn(
      `[collision] verify: no live session of ${login} contains ${filePath} — skipping ring`,
    );
    return;
  }
  rail.markCollision(login, filePath);
}

function anyLiveSessionTouchesFile(sessions: InfoSession[], filePath: string): boolean {
  for (const s of sessions) {
    if (s.state === "ended") continue;
    const sets = [s.topFilesEdited, s.topFilesWritten];
    for (const set of sets) {
      if (!Array.isArray(set)) continue;
      for (const entry of set) {
        if (Array.isArray(entry) && entry[0] === filePath) return true;
      }
    }
  }
  return false;
}

export function registerWsHandlers(): void {
  ws.onPrActivity((msg) => {
    console.log(
      `[ws] pr_activity ${msg.action} by ${msg.login} on ${msg.repoFullName}#${msg.number}`,
    );
    rail.markPrActivity(msg.login);
    // Project overview's LLM-derived pulse+buckets depend on the in-window
    // PR set. A new opened/merged PR changes the set; drop the desktop cache
    // so the next hover refetches. (Server-side cache key folds in the PR
    // fingerprint too, so the LLM call also reruns.)
    info.invalidateProjectOverview(msg.repoFullName);
  });

  ws.onCollisionDetected((msg) => {
    console.log(
      `[ws] collision_detected on ${msg.file_path} (trigger=${msg.trigger.githubLogin} others=${msg.others.map((o) => o.githubLogin).join(",")})`,
    );
    const state = backend.getAuthState();
    const selfLogin = state.signedIn ? state.user.githubLogin : null;
    // Stamp every involved peer (trigger + others) — but verify each one's
    // session data actually contains the file before painting the ring. This
    // is what keeps ring + popover warning in lockstep: if no live session
    // for a peer touches the file (stale cache, races, weird edge cases),
    // we don't paint a ring with no explanation.
    if (msg.trigger.githubLogin !== selfLogin) {
      void verifyAndMarkCollision(msg.trigger.githubLogin, msg.file_path);
    }
    for (const other of msg.others) {
      if (other.githubLogin === selfLogin) continue;
      void verifyAndMarkCollision(other.githubLogin, msg.file_path);
    }
  });

  ws.onSessionInsightsUpdated((msg) => {
    console.log(
      `[insights] ${msg.analyzer} ready for session ${msg.session_id.slice(0, 8)} (repo=${msg.repo_id})`,
      msg.output,
    );
    info.scheduleRefresh(msg.session_id);
    broadcast("ws:sessionInsightsUpdated", msg, getMainWindow());
  });

  ws.onSessionUpdated((msg) => {
    // Drop the owner's cache so a non-selected head goes stale-free on next
    // hover. info.scheduleRefresh then coalesces any UI refresh for the
    // currently-selected head across bursty events.
    info.invalidateSessionCache(rail.userHeadId(msg.github_login));
    rail.refreshSoon();
    info.scheduleRefresh(msg.session_id);
    broadcast("ws:sessionUpdated", msg, getMainWindow());
  });

  // Local uploader ingestion invalidates the self-head cache synchronously —
  // faster than waiting for the server-side WS echo for your own sessions.
  uploader.onIngested(() => {
    const state = backend.getAuthState();
    if (!state.signedIn) return;
    info.invalidateSessionCache(rail.userHeadId(state.user.githubLogin));
  });
}
