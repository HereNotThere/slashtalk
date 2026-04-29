// "Add local repo" feature: folder picker, .git/config GitHub-remote parsing,
// and a reducer over the server's device_repo_paths set. Any change re-POSTs
// the full set to /v1/devices/:id/repos (the endpoint replaces the whole set).

import { execFile } from "node:child_process";
import { dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TrackedRepo } from "../shared/types";
import * as backend from "./backend";
import * as store from "./store";
import { createEmitter } from "./emitter";
import { isPathTrackedAgainst } from "./pathTracking";

const execFileAsync = promisify(execFile);

/** True if `cwd` lives under any tracked local repo path, or under a git
 *  linked worktree whose main repo is tracked. Symlink-aware (see
 *  `isPathTrackedAgainst` in `./pathTracking`). */
export function isPathTracked(cwd: string | null | undefined): boolean {
  return isPathTrackedAgainst(
    cwd,
    tracked.map((r) => r.localPath),
  );
}

const TRACKED_KEY = "trackedRepos";
const SELECTION_KEY = "trackedReposSelection";

let tracked: TrackedRepo[] = [];
// Per-repo "include in rail filter" toggle. Default ON when a repo is added,
// persisted across launches. Stored as repoId so rename of fullName on GitHub
// doesn't desync the user's choice.
let selectedIds = new Set<number>();
// Last-known set of repo IDs successfully synced to the server's user_repos.
// Diffed against `selectedIds` whenever a selection event fires; new entries
// trigger `claimRepo`, removed entries trigger `unclaimRepo`. Starts empty so
// the first reconciliation after sign-in claims everything currently
// selected — covers the case where local persisted selection doesn't match
// server state (different device, manual DB edit, partial prior failure).
let syncedRepoIds = new Set<number>();
let reconcilingClaims = false;
// Set when `reconcileClaims` is called while a prior reconcile is in flight.
// The in-flight pass loops once more after it finishes whenever this is true,
// so toggles during the async window can't be silently dropped.
let reconcilePending = false;
const changes = createEmitter<TrackedRepo[]>();
const selectionChanges = createEmitter<Set<number>>();

export function restore(): void {
  const saved = store.get<TrackedRepo[]>(TRACKED_KEY);
  if (Array.isArray(saved)) tracked = saved;
  const savedSelection = store.get<number[]>(SELECTION_KEY);
  if (Array.isArray(savedSelection)) {
    selectedIds = new Set(savedSelection.filter((n) => typeof n === "number"));
  } else {
    // First launch or legacy store: default every tracked repo ON.
    selectedIds = new Set(tracked.map((t) => t.repoId));
  }
  // Hook up the claim reconciler exactly once. Subsequent selection changes
  // (toggle, prune-on-remove, rehydrate) all flow through it.
  selectionChanges.on(reconcileClaims);
  backend.onChange((state) => {
    if (state.signedIn) {
      // Reset synced-state so the first emit after sign-in re-claims every
      // currently-selected repo. Idempotent server-side (`onConflictDoNothing`).
      syncedRepoIds = new Set();
      void rehydrateFromServer().then(() => {
        // Even if rehydrate didn't mutate selectedIds (no new repos arrived),
        // we still want to reconcile against the empty syncedRepoIds — a kick.
        selectionChanges.emit(new Set(selectedIds));
      });
    }
  });
  if (backend.getAuthState().signedIn) {
    syncedRepoIds = new Set();
    void rehydrateFromServer().then(() => {
      selectionChanges.emit(new Set(selectedIds));
    });
  }
}

// Diffs `current` against `syncedRepoIds` and runs the claim/unclaim deltas.
// Designed as the single point that touches `user_repos` server-side so each
// UI surface (settings X, tray tick, rehydrate) just toggles local state and
// trusts this subscriber to catch up. Re-emits `selectionChanges` once after
// a successful round so cache listeners (info-card `dashboardCache`) clear
// against post-sync state, not the optimistic local one.
async function reconcileClaims(): Promise<void> {
  if (reconcilingClaims) {
    // Another emit fired while we're mid-reconcile. The current pass will
    // pick up the latest `selectedIds` on its next loop iteration via the
    // pending flag — bail without re-entering.
    reconcilePending = true;
    return;
  }
  if (!backend.getAuthState().signedIn) return;
  reconcilingClaims = true;
  try {
    do {
      reconcilePending = false;
      const target = new Set(selectedIds);
      const toClaim = [...target].filter((id) => !syncedRepoIds.has(id));
      const toUnclaim = [...syncedRepoIds].filter((id) => !target.has(id));
      if (toClaim.length === 0 && toUnclaim.length === 0) break;
      let mutated = false;
      for (const repoId of toClaim) {
        const repo = tracked.find((t) => t.repoId === repoId);
        if (!repo) continue;
        try {
          await backend.claimRepo(repo.fullName);
          syncedRepoIds.add(repoId);
          mutated = true;
        } catch (err) {
          console.warn(`[localRepos] reconcile claim(${repoId}) failed:`, err);
        }
      }
      for (const repoId of toUnclaim) {
        try {
          await backend.unclaimRepo(repoId);
          syncedRepoIds.delete(repoId);
          mutated = true;
        } catch (err) {
          console.warn(`[localRepos] reconcile unclaim(${repoId}) failed:`, err);
        }
      }
      if (mutated) selectionChanges.emit(new Set(selectedIds));
    } while (reconcilePending);
  } finally {
    reconcilingClaims = false;
  }
}

// Pulls the device's registered paths from the server and adopts them as the
// local tracked list. Runs on sign-in and at cold-start if already signed in.
// Server-wins is safe because every local add/remove already round-trips to
// `POST /v1/devices/:id/repos`, so the server is at least as fresh as local.
let rehydrating = false;
async function rehydrateFromServer(): Promise<void> {
  if (rehydrating) return;
  rehydrating = true;
  try {
    const rows = await backend.listDeviceRepos();
    const next: TrackedRepo[] = rows.map((r) => ({
      repoId: r.repoId,
      fullName: r.fullName,
      localPath: r.localPath,
    }));
    if (sameTracked(tracked, next)) return;
    // Repos arriving from the server that we haven't seen locally default to
    // ON in the rail filter. Without this, a user who adds a repo on another
    // device would see it tracked here but silently filtered out of the rail.
    const knownIds = new Set(tracked.map((t) => t.repoId));
    let selectionMutated = false;
    for (const row of next) {
      if (!knownIds.has(row.repoId) && !selectedIds.has(row.repoId)) {
        selectedIds.add(row.repoId);
        selectionMutated = true;
      }
    }
    if (selectionMutated) persistSelection();
    apply(next);
    if (selectionMutated) selectionChanges.emit(new Set(selectedIds));
  } catch (err) {
    console.warn("[localRepos] rehydrate failed:", (err as Error).message);
  } finally {
    rehydrating = false;
  }
}

function sameTracked(a: TrackedRepo[], b: TrackedRepo[]): boolean {
  if (a.length !== b.length) return false;
  const key = (r: TrackedRepo): string => `${r.repoId}|${r.localPath}`;
  const aKeys = new Set(a.map(key));
  return b.every((r) => aKeys.has(key(r)));
}

export function list(): TrackedRepo[] {
  return tracked;
}

export const onChange = changes.on;
export const onSelectionChange = selectionChanges.on;

/** Repo IDs currently included in the rail filter. */
export function selectedRepoIds(): Set<number> {
  return new Set(selectedIds);
}

/** FullNames of tracked+selected repos. Used by rail filter. */
export function selectedFullNames(): Set<string> {
  const byId = new Map(tracked.map((t) => [t.repoId, t.fullName.toLowerCase()]));
  const out = new Set<string>();
  for (const id of selectedIds) {
    const fn = byId.get(id);
    if (fn) out.add(fn);
  }
  return out;
}

/** Toggle a tracked repo's membership in the filter set. Returns the new
 *  selected set. A repoId not currently tracked is ignored. The
 *  server-side `user_repos` claim is reconciled by a single subscriber on
 *  `selectionChanges` (see below) — UI handlers stay sync and unaware of
 *  the network round-trip. */
export function toggleSelected(repoId: number): Set<number> {
  if (!tracked.some((t) => t.repoId === repoId)) return selectedIds;
  if (selectedIds.has(repoId)) selectedIds.delete(repoId);
  else selectedIds.add(repoId);
  persistSelection();
  selectionChanges.emit(new Set(selectedIds));
  return selectedIds;
}

function persist(): void {
  store.set(TRACKED_KEY, tracked);
}

function persistSelection(): void {
  store.set(SELECTION_KEY, [...selectedIds]);
}

function apply(next: TrackedRepo[]): void {
  tracked = next;
  persist();
  // Prune selection to known IDs so a removed repo doesn't leave a dangling
  // entry that would silently re-activate if the same repoId appeared later.
  const known = new Set(tracked.map((t) => t.repoId));
  let mutated = false;
  for (const id of selectedIds) {
    if (!known.has(id)) {
      selectedIds.delete(id);
      mutated = true;
    }
  }
  if (mutated) {
    persistSelection();
    selectionChanges.emit(new Set(selectedIds));
  }
  changes.emit(tracked);
}

async function syncDeviceRepos(next: TrackedRepo[]): Promise<void> {
  await backend.postDeviceRepos({
    repoPaths: next.map((t) => ({ repoId: t.repoId, localPath: t.localPath })),
    excludedRepoIds: [],
  });
}

/**
 * Prompts for a folder, validates it's a clone of a GitHub repo, claims it
 * server-side, and registers the local path with the user's device.
 *
 * Returns `null` if the user cancelled the dialog. Throws with a message for
 * any other failure (not a git repo, no GitHub remote, already tracked, etc.).
 */
export async function addLocalRepo(): Promise<TrackedRepo | null> {
  if (!backend.getAuthState().signedIn) {
    throw new Error("Sign in to slashtalk first");
  }

  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Pick a local repository",
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const localPath = result.filePaths[0];
  const remote = await readGithubRemote(localPath);
  if (remote.kind === "not_git") {
    throw new Error(`${localPath} is not a git repository`);
  }
  if (remote.kind === "no_github_remote") {
    throw new Error("No GitHub remote found in this repo");
  }

  const fullName = `${remote.owner}/${remote.name}`;
  // GitHub repo names are case-insensitive; dedupe across casings to avoid
  // registering the same repo twice if the user has two clones.
  if (tracked.some((t) => t.fullName.toLowerCase() === fullName.toLowerCase())) {
    throw new Error(`${fullName} is already tracked`);
  }

  let claimed;
  try {
    claimed = await backend.claimRepo(fullName);
  } catch (err) {
    // The server-side claim-gate (core-beliefs #12) returns structured errors
    // that carry a user-facing `message`. On `token_expired`, also flip the UI
    // to signed-out — the stored OAuth token no longer sees this user's
    // repos, so everything downstream is broken until they re-auth.
    if (err instanceof backend.ClaimRepoError) {
      if (err.kind === "token_expired") {
        void backend.signOut().catch(() => {});
      }
      throw new Error(err.message, { cause: err });
    }
    throw err;
  }
  const entry: TrackedRepo = {
    repoId: claimed.repoId,
    fullName: claimed.fullName,
    localPath,
  };
  const next = [...tracked, entry];
  await syncDeviceRepos(next);
  // Auto-select on add: the common case is "I'm adding this because I care
  // about it right now." Pruning in `apply()` handles the reverse.
  selectedIds.add(entry.repoId);
  persistSelection();
  // We just claimed this repo eagerly (above) so the user sees errors
  // immediately. Tell the reconciler about it so the subsequent
  // selectionChanges emit doesn't trigger a redundant re-claim.
  syncedRepoIds.add(entry.repoId);
  apply(next);
  selectionChanges.emit(new Set(selectedIds));
  return entry;
}

export async function removeLocalRepo(repoId: number): Promise<TrackedRepo[]> {
  if (!backend.getAuthState().signedIn) return tracked;
  const next = tracked.filter((t) => t.repoId !== repoId);
  if (next.length === tracked.length) return tracked;
  await syncDeviceRepos(next);
  // `apply` prunes selectedIds for the removed repo, which fires
  // selectionChanges → the claim reconciler unclaims it server-side.
  apply(next);
  return tracked;
}

export function clearOnSignOut(): void {
  if (tracked.length === 0 && selectedIds.size === 0) return;
  selectedIds.clear();
  persistSelection();
  selectionChanges.emit(new Set());
  apply([]);
}

// ---------- .git/config parsing ----------

type RemoteResult =
  | { kind: "ok"; owner: string; name: string }
  | { kind: "not_git" }
  | { kind: "no_github_remote" };

type ParsedRemote = {
  kind: "https" | "ssh";
  host: string;
  owner: string;
  name: string;
};

// Parses git remote URLs into {host, owner, name}. Covers:
//   https://host/owner/repo(.git)
//   git@host:owner/repo(.git)           (SCP-style)
//   ssh://[user@]host[:port]/owner/repo(.git)
//   git://host/owner/repo(.git)
// `host` may be a literal hostname or an ssh_config alias.
export function parseGitRemote(url: string): ParsedRemote | null {
  const stripSuffix = (s: string): string => s.replace(/\.git$/i, "");

  // SCP-style: [user@]host:owner/repo. Host must not contain `/` (that would
  // be a URL path) and the path must be exactly owner/repo.
  const scp = url.match(/^(?:[^@\s]+@)?([^:\s/]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (scp) {
    return {
      kind: "ssh",
      host: scp[1].toLowerCase(),
      owner: scp[2],
      name: stripSuffix(scp[3]),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const name = stripSuffix(segments[1]);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    return { kind: "https", host, owner, name };
  }
  if (parsed.protocol === "ssh:" || parsed.protocol === "git:") {
    return { kind: "ssh", host, owner, name };
  }
  return null;
}

const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);

// Runs `ssh -G <alias>` and returns the effective `hostname` ssh would dial
// after resolving the user's ssh_config (Host, Match, Include, token
// expansion). Pure config resolution — no network, no key loading. Returns
// null if ssh is missing, times out, or prints no hostname line.
async function resolveSshHost(alias: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ssh", ["-G", alias], {
      timeout: 2000,
    });
    for (const line of stdout.split("\n")) {
      if (line.startsWith("hostname ")) {
        return line.slice("hostname ".length).trim().toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolvesToGithub(parsed: ParsedRemote): Promise<boolean> {
  if (GITHUB_HOSTS.has(parsed.host)) return true;
  if (parsed.kind !== "ssh") return false;
  const resolved = await resolveSshHost(parsed.host);
  return resolved !== null && GITHUB_HOSTS.has(resolved);
}

async function readGithubRemote(localPath: string): Promise<RemoteResult> {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(localPath, ".git", "config"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "not_git" };
    }
    throw err;
  }

  const urls = extractRemoteUrls(contents);
  // Origin wins if present, even when it points elsewhere — matches prior
  // behavior and avoids silently tracking a non-origin remote. Only scan
  // other remotes when `origin` is absent.
  const origin = urls.get("origin");
  const candidates = origin ? [origin] : [...urls.values()];

  for (const url of candidates) {
    const parsed = parseGitRemote(url);
    if (!parsed) continue;
    if (await resolvesToGithub(parsed)) {
      return { kind: "ok", owner: parsed.owner, name: parsed.name };
    }
  }
  return { kind: "no_github_remote" };
}

function extractRemoteUrls(config: string): Map<string, string> {
  const urls = new Map<string, string>();
  const sectionHeader = /^\[remote "([^"]+)"\]\s*$/;
  const urlLine = /^\s*url\s*=\s*(.+?)\s*$/;
  let currentRemote: string | null = null;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(sectionHeader);
    if (section) {
      currentRemote = section[1];
      continue;
    }
    if (line.startsWith("[")) {
      currentRemote = null;
      continue;
    }
    if (currentRemote) {
      const url = line.match(urlLine);
      if (url) urls.set(currentRemote, url[1]);
    }
  }
  return urls;
}
