// "Add local repo" feature: folder picker, .git/config GitHub-remote parsing,
// and a reducer over the server's device_repo_paths set. Any change re-POSTs
// the full set to /v1/devices/:id/repos (the endpoint replaces the whole set).

import { dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { TrackedRepo } from "../shared/types";
import * as backend from "./backend";
import * as store from "./store";
import { createEmitter } from "./emitter";

/** True if `cwd` lives under any tracked local repo path, or under a git
 *  linked worktree whose main repo is tracked. */
export function isPathTracked(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const abs = path.resolve(cwd);
  const absWithSep = abs + path.sep;
  for (const r of tracked) {
    const root = path.resolve(r.localPath);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (absWithSep.startsWith(prefix)) return true;
  }
  const mainRepo = resolveWorktreeMainRepo(abs);
  if (!mainRepo) return false;
  return tracked.some((r) => path.resolve(r.localPath) === mainRepo);
}

// A linked worktree's `.git` is a file: `gitdir: <main>/.git/worktrees/<name>`.
// Walk up from cwd, and if we find that shape, return <main>.
function resolveWorktreeMainRepo(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const gitPath = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      // no .git at this level; keep walking up
    }
    if (stat?.isDirectory()) return null; // plain repo, not a worktree
    if (stat?.isFile()) {
      let contents: string;
      try {
        contents = fs.readFileSync(gitPath, "utf8");
      } catch {
        return null;
      }
      const m = contents.match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1]);
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      const idx = gitdir.indexOf(marker);
      return idx === -1 ? null : gitdir.slice(0, idx);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const TRACKED_KEY = "trackedRepos";

let tracked: TrackedRepo[] = [];
const changes = createEmitter<TrackedRepo[]>();

export function restore(): void {
  const saved = store.get<TrackedRepo[]>(TRACKED_KEY);
  if (Array.isArray(saved)) tracked = saved;
  backend.onChange((state) => {
    if (state.signedIn) void rehydrateFromServer();
  });
  if (backend.getAuthState().signedIn) void rehydrateFromServer();
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
    if (!sameTracked(tracked, next)) apply(next);
  } catch (err) {
    console.warn(
      "[localRepos] rehydrate failed:",
      (err as Error).message,
    );
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

function persist(): void {
  store.set(TRACKED_KEY, tracked);
}

function apply(next: TrackedRepo[]): void {
  tracked = next;
  persist();
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
  const remote = readGithubRemote(localPath);
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

  const claimed = await backend.claimRepo(fullName);
  const entry: TrackedRepo = {
    repoId: claimed.repoId,
    fullName: claimed.fullName,
    localPath,
  };
  const next = [...tracked, entry];
  await syncDeviceRepos(next);
  apply(next);
  return entry;
}

export async function removeLocalRepo(repoId: number): Promise<TrackedRepo[]> {
  if (!backend.getAuthState().signedIn) return tracked;
  const next = tracked.filter((t) => t.repoId !== repoId);
  if (next.length === tracked.length) return tracked;
  await syncDeviceRepos(next);
  apply(next);
  return tracked;
}

export function clearOnSignOut(): void {
  if (tracked.length === 0) return;
  apply([]);
}

// ---------- .git/config parsing ----------

type RemoteResult =
  | { kind: "ok"; owner: string; name: string }
  | { kind: "not_git" }
  | { kind: "no_github_remote" };

// Matches the handful of forms git writes for a github.com remote:
//   https://github.com/owner/repo(.git)
//   git@github.com:owner/repo(.git)
//   ssh://git@github.com/owner/repo(.git)
const GITHUB_URL = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i;

function readGithubRemote(localPath: string): RemoteResult {
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
  const origin = urls.get("origin");
  const candidate = origin ?? [...urls.values()].find((u) => GITHUB_URL.test(u));
  const match = candidate?.match(GITHUB_URL);
  if (!match) return { kind: "no_github_remote" };
  return { kind: "ok", owner: match[1], name: match[2] };
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
