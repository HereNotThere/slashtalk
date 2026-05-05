/**
 * Loads a session by id and returns it iff the caller owns it or has access
 * via `user_repos` (CLAUDE.md rule #13: `user_repos` is the only authorization
 * for cross-user reads).
 *
 * Returns null when the session doesn't exist OR the caller has no access.
 * Callers should treat both as 404 — surfacing "exists but forbidden" would
 * leak the existence of sessions in repos the caller can't see.
 */
export { loadAccessibleSession } from "../repo/visibility";
