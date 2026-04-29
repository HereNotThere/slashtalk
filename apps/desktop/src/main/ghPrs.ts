// Local replacement for the server's /api/users/:login/prs endpoint. Runs the
// caller's `gh` CLI to query GitHub directly, so PR data on the user-card is
// fresh (no poller lag) and authorized by the caller's token (which is the
// natural visibility boundary anyway). When `gh` isn't installed or signed
// in, returns the appropriate ghStatus so the renderer can show an inline
// install/auth nudge instead of a misleading empty list.
//
// Uses `gh api graphql` rather than `gh search prs` because the search CLI
// doesn't expose `headRefName` as a JSON field — and we need it to upsert
// rows into the server's `pull_requests` table (head_ref NOT NULL) when
// pushing self-PRs back so the standup composer can see them.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DashboardScope, UserPr } from "@slashtalk/shared";
import type { GhStatus } from "../shared/types";

const execFileAsync = promisify(execFile);

export type { GhStatus };

export interface GhPr extends UserPr {
  /** PR's source branch — used by the server's session↔PR linker. Always
   *  populated when ghStatus === "ready". */
  headRef: string;
}

export interface GhUserPrsResult {
  prs: GhPr[];
  ghStatus: GhStatus;
}

interface GraphqlPrNode {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  updatedAt: string;
  headRefName: string;
  repository: { nameWithOwner: string };
}

interface GraphqlSearchResponse {
  // Nodes are loosely typed: GitHub returns `null` for entries the viewer
  // can't see, and the inline-fragment shape means non-PR types arrive as
  // `{}`. The mapping below filters both out before relying on fields.
  data?: { search?: { nodes?: (Partial<GraphqlPrNode> | null)[] } };
  errors?: { message?: string }[];
}

const SEARCH_LIMIT = 50;

const GRAPHQL_QUERY = `query($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number title state url headRefName updatedAt
        repository { nameWithOwner }
      }
    }
  }
}`;

// Cache the "ready" state once we've seen it — gh auth doesn't disappear
// during a session in practice. Failure states are NOT cached: a user who
// follows the install/auth nudge needs the next hover to discover their
// fixed setup, otherwise the nudge is a dead-end until app restart.
// `gh auth status` exits 0 only when installed AND authed; ENOENT
// distinguishes missing-binary from "installed but logged out" via stderr.
let cachedReady: Promise<"ready"> | null = null;

export function probeGhStatus(): Promise<GhStatus> {
  if (cachedReady) return cachedReady;
  const attempt = execFileAsync("gh", ["auth", "status"], { timeout: 5000 })
    .then((): GhStatus => "ready")
    .catch(
      (err: NodeJS.ErrnoException): GhStatus => (err.code === "ENOENT" ? "missing" : "unauthed"),
    );
  void attempt.then((status) => {
    if (status === "ready") cachedReady = Promise.resolve("ready");
  });
  return attempt;
}

export async function fetchGhUserPrs(
  login: string,
  scope: DashboardScope,
): Promise<GhUserPrsResult> {
  const ghStatus = await probeGhStatus();
  if (ghStatus !== "ready") return { prs: [], ghStatus };

  const since = windowStartIso(scope);
  const q = `author:${login} type:pr updated:>=${since}`;
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${GRAPHQL_QUERY}`,
    "-F",
    `q=${q}`,
    "-F",
    `first=${SEARCH_LIMIT}`,
  ];

  let stdout: string;
  try {
    const result = await execFileAsync("gh", args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (err) {
    console.warn(`[ghPrs] graphql failed login=${login}:`, (err as Error).message);
    return { prs: [], ghStatus: "ready" };
  }

  let parsed: GraphqlSearchResponse;
  try {
    parsed = JSON.parse(stdout) as GraphqlSearchResponse;
  } catch (err) {
    console.warn(`[ghPrs] parse failed login=${login}:`, (err as Error).message);
    return { prs: [], ghStatus: "ready" };
  }
  if (parsed.errors?.length) {
    console.warn(`[ghPrs] graphql errors login=${login}:`, parsed.errors[0]?.message);
    return { prs: [], ghStatus: "ready" };
  }
  // GitHub's search connection can return `null` (viewer lost access) or
  // `{}` (non-PullRequest types matching the inline fragment) — drop both
  // before mapping so a single bad node doesn't blow up the whole list.
  const nodes = (parsed.data?.search?.nodes ?? []).filter(
    (p): p is GraphqlPrNode => !!p && typeof p.state === "string" && !!p.repository?.nameWithOwner,
  );

  const prs: GhPr[] = nodes.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state.toLowerCase() as UserPr["state"],
    repoFullName: p.repository.nameWithOwner,
    updatedAt: p.updatedAt,
    headRef: p.headRefName,
  }));
  return { prs, ghStatus: "ready" };
}

function windowStartIso(scope: DashboardScope): string {
  // Local-time "today" — caller's machine is the natural reference for a
  // hover that's happening on their screen. GitHub's search syntax accepts
  // ISO-8601 (with offset).
  if (scope === "past24h") {
    return toIsoMinute(new Date(Date.now() - 24 * 60 * 60 * 1000));
  }
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return toIsoMinute(d);
}

function toIsoMinute(d: Date): string {
  return d.toISOString().slice(0, 16) + "Z";
}
