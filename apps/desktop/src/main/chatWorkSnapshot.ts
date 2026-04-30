import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatWorkSnapshot, ChatWorkSnapshotPr } from "@slashtalk/shared";
import type { GhStatus, TrackedRepo } from "../shared/types";
import { probeGhStatus } from "./ghPrs";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const GH_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_STATUS_LINES = 80;
const MAX_CHANGED_FILES = 200;
const MAX_DIFF_STAT_CHARS = 12_000;
const MAX_COMMITS = 30;
const MAX_LINE_CHARS = 1000;
const MAX_PRS = 20;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFileRunner = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<ExecResult>;

export interface SnapshotCollectorDeps {
  execFile?: ExecFileRunner;
  probeGhStatus?: () => Promise<GhStatus>;
  now?: () => Date;
}

interface GhPrJson {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  author?: { login?: string } | null;
}

const defaultExecFile: ExecFileRunner = async (file, args, opts) => {
  const result = await execFileAsync(file, args, { ...opts, encoding: "utf8" });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export async function collectChatWorkSnapshot(
  repo: TrackedRepo,
  deps: SnapshotCollectorDeps = {},
): Promise<ChatWorkSnapshot> {
  const run = deps.execFile ?? defaultExecFile;
  const now = deps.now ?? (() => new Date());
  const errors: string[] = [];

  const git = async (label: string, args: string[]): Promise<string | null> => {
    try {
      const result = await run("git", ["-C", repo.localPath, ...args], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      return result.stdout;
    } catch {
      errors.push(`${label} unavailable`);
      return null;
    }
  };

  const [branchOut, headOut, statusOut, diffStatOut, commitsOut] = await Promise.all([
    git("branch", ["rev-parse", "--abbrev-ref", "HEAD"]),
    git("head", ["rev-parse", "--verify", "HEAD"]),
    git("status", ["status", "--short", "--branch", "--untracked-files=normal"]),
    git("diffstat", ["diff", "--stat", "--compact-summary", "HEAD", "--"]),
    git("recent commits", [
      "log",
      "--oneline",
      "--decorate=short",
      "-n",
      String(MAX_COMMITS),
      "--",
    ]),
  ]);

  const branch = normalizeScalar(branchOut);
  const safeBranch = branch && branch !== "HEAD" ? branch : null;
  const statusShort = toLines(statusOut, MAX_STATUS_LINES);
  const changedFiles = parseChangedFiles(statusShort).slice(0, MAX_CHANGED_FILES);
  const diffStat = normalizeBlock(diffStatOut, MAX_DIFF_STAT_CHARS);
  const recentCommits = toLines(commitsOut, MAX_COMMITS);
  const ghStatus = await safeProbeGhStatus(deps.probeGhStatus ?? probeGhStatus);
  const relatedPrs =
    ghStatus === "ready" && safeBranch ? await fetchRelatedPrs(repo, safeBranch, run, errors) : [];

  return {
    repo: {
      repoId: repo.repoId,
      fullName: repo.fullName,
    },
    collectedAt: now().toISOString(),
    branch: safeBranch,
    headSha: normalizeScalar(headOut),
    statusShort,
    changedFiles,
    diffStat,
    recentCommits,
    relatedPrs,
    ghStatus,
    ...(errors.length > 0 ? { collectionErrors: unique(errors).slice(0, 20) } : {}),
  };
}

async function safeProbeGhStatus(probe: () => Promise<GhStatus>): Promise<GhStatus> {
  try {
    return await probe();
  } catch {
    return "unauthed";
  }
}

async function fetchRelatedPrs(
  repo: TrackedRepo,
  branch: string,
  run: ExecFileRunner,
  errors: string[],
): Promise<ChatWorkSnapshotPr[]> {
  try {
    const result = await run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo.fullName,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,title,url,state,headRefName,baseRefName,updatedAt,author",
        "--limit",
        String(MAX_PRS),
      ],
      { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_PRS).flatMap(parsePr);
  } catch {
    errors.push("related PR lookup unavailable");
    return [];
  }
}

function parsePr(raw: unknown): ChatWorkSnapshotPr[] {
  const pr = raw as GhPrJson;
  if (typeof pr.number !== "number" || typeof pr.title !== "string" || typeof pr.url !== "string") {
    return [];
  }
  const state = normalizePrState(pr.state);
  if (!state) return [];
  return [
    {
      number: pr.number,
      title: truncateLine(pr.title, 500),
      url: truncateLine(pr.url, 1000),
      state,
      headRef: typeof pr.headRefName === "string" ? truncateLine(pr.headRefName, 256) : null,
      baseRef: typeof pr.baseRefName === "string" ? truncateLine(pr.baseRefName, 256) : null,
      authorLogin: typeof pr.author?.login === "string" ? truncateLine(pr.author.login, 256) : null,
      updatedAt: typeof pr.updatedAt === "string" ? truncateLine(pr.updatedAt, 64) : null,
    },
  ];
}

function normalizePrState(raw: string | undefined): ChatWorkSnapshotPr["state"] | null {
  const state = raw?.toLowerCase();
  if (state === "open" || state === "closed" || state === "merged") return state;
  return null;
}

function normalizeScalar(raw: string | null): string | null {
  const line =
    raw
      ?.split(/\r?\n/)
      .find((part) => part.trim().length > 0)
      ?.trim() ?? "";
  return line ? truncateLine(line, MAX_LINE_CHARS) : null;
}

function normalizeBlock(raw: string | null, maxChars: number): string | null {
  const text = raw?.trimEnd() ?? "";
  if (!text.trim()) return null;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function toLines(raw: string | null, maxLines: number): string[] {
  return (raw ?? "")
    .split(/\r?\n/)
    .map((line) => truncateLine(line.trimEnd(), MAX_LINE_CHARS))
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines);
}

function parseChangedFiles(statusShort: string[]): string[] {
  const files = statusShort
    .filter((line) => !line.startsWith("## "))
    .flatMap((line) => {
      const raw = line.slice(3).trim();
      if (!raw) return [];
      const renamed = raw.split(" -> ");
      return renamed.length === 2 ? renamed : [raw];
    })
    .map((line) => truncateLine(line, MAX_LINE_CHARS));
  return unique(files);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function truncateLine(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
