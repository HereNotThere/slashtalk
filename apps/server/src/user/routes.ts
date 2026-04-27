import { Elysia, t } from "elysia";
import { eq, and, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db";
import {
  users,
  devices,
  repos,
  userRepos,
  setupTokens,
  apiKeys,
  deviceExcludedRepos,
  deviceRepoPaths,
  sessions,
} from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { decryptGithubToken } from "../auth/tokens";
import { authAudit } from "../auth/audit";
import { revokeAllUserCredentials } from "../auth/sessions";
import {
  fetchUserGithubAppToken,
  githubAppConnectionStatus,
  githubAppConnectUrl,
  githubAppConnectUrlForUser,
  githubAppInstallUrl,
  isGithubAppConfigured,
} from "../auth/github-app";
import { config } from "../config";
import { matchSessionRepo, normalizeFullName } from "../social/github-sync";
import type { OrgSummary, OrgRepo } from "@slashtalk/shared";

// "owner/name" — GitHub's constraints apply: 1-39 chars for owner, 1-100 for name.
const FULL_NAME = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// GitHub org login: 1-39 chars of letters, digits, or hyphens.
const ORG_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

// Per-user caches for the GitHub-proxied lookups. The tray popup opens/closes
// repeatedly — hitting GitHub every time would burn rate limit and feel slow.
// Keyed by userId / `${userId}:${org}`; entries expire after 60s.
const ORGS_TTL_MS = 60_000;
const orgsCache = new Map<number, { at: number; value: OrgSummary[] }>();
const orgReposCache = new Map<string, { at: number; value: OrgRepo[] }>();

// Claim-verification cache: dedups a repeated `GET /repos/:owner/:name` for
// the same (user, fullName) pair (desktop double-clicks, retry-on-failure).
// Keyed by `${userId}:${fullName-lower}`.
const CLAIM_VERIFY_TTL_MS = 60_000;
const claimVerifyCache = new Map<string, { at: number; value: VerifiedRepo }>();

// Per-user rate-limit for `POST /api/me/repos`. Blocks an adversary with a
// stolen JWT from enumerating private repos by brute-forcing fullNames.
// Token-bucket, in-memory only (sufficient for single-node deploy; revisit
// if we go multi-node before shipping a durable store).
const CLAIM_RATE_WINDOW_MS = 60 * 60 * 1000;
const CLAIM_RATE_MAX = 30;
const claimRateBuckets = new Map<number, number[]>();
// When the maps grow past this, run a full sweep to drop expired entries.
// Memory protection for a long-lived single process.
const SWEEP_THRESHOLD = 5_000;

function sweepClaimCaches(now: number): void {
  if (claimRateBuckets.size < SWEEP_THRESHOLD && claimVerifyCache.size < SWEEP_THRESHOLD) {
    return;
  }
  const rateCutoff = now - CLAIM_RATE_WINDOW_MS;
  for (const [userId, ts] of claimRateBuckets) {
    const fresh = ts.filter((t) => t > rateCutoff);
    if (fresh.length === 0) claimRateBuckets.delete(userId);
    else if (fresh.length !== ts.length) claimRateBuckets.set(userId, fresh);
  }
  for (const [key, entry] of claimVerifyCache) {
    if (now - entry.at >= CLAIM_VERIFY_TTL_MS) claimVerifyCache.delete(key);
  }
}

/** Test-only: reset the GitHub-proxy caches + claim-gate state so assertions
 *  don't bleed across cases. No production path calls this. */
export function __clearOrgCaches(): void {
  orgsCache.clear();
  orgReposCache.clear();
  claimVerifyCache.clear();
  claimRateBuckets.clear();
}

/** Returns true if `userId` is under the per-hour claim cap; records the
 *  attempt as a side-effect. Trims stale timestamps opportunistically; drops
 *  the bucket entirely when no fresh entries remain so dormant users don't
 *  linger in memory forever. */
function recordClaimAttempt(userId: number): boolean {
  const now = Date.now();
  sweepClaimCaches(now);
  const cutoff = now - CLAIM_RATE_WINDOW_MS;
  const prior = claimRateBuckets.get(userId) ?? [];
  const fresh = prior.filter((t) => t > cutoff);
  if (fresh.length >= CLAIM_RATE_MAX) {
    claimRateBuckets.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  claimRateBuckets.set(userId, fresh);
  return true;
}

interface VerifiedRepo {
  githubId: number;
  fullName: string; // GitHub's canonical casing
  owner: string;
  name: string;
  private: boolean;
}

type VerifyOutcome =
  | { ok: true; repo: VerifiedRepo }
  | {
      ok: false;
      kind:
        | "no_access"
        | "github_app_required"
        | "github_grant_revoked"
        | "token_expired"
        | "upstream_unavailable";
    };

/** Ask GitHub, using the user's stored OAuth token, whether they can see
 *  `owner/name`. 200 = yes (canonical repo data returned); 404 = no (fail
 *  closed); 401/403 = token bad (caller should re-auth); fetch/5xx errors
 *  = upstream unavailable (retry later). Never falls back to "accept." */
async function verifyRepoAccess(
  token: string,
  owner: string,
  name: string,
): Promise<VerifyOutcome> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { headers: githubHeaders(token) },
    );
  } catch (err) {
    console.warn(`[claim] fetch /repos/${owner}/${name} threw:`, (err as Error).message);
    return { ok: false, kind: "upstream_unavailable" };
  }
  if (res.status === 404) {
    return { ok: false, kind: "no_access" };
  }
  if (res.status === 401) {
    console.warn(
      `[claim] GitHub 401 on /repos/${owner}/${name} — OAuth grant revoked or token invalid`,
    );
    return { ok: false, kind: "github_grant_revoked" };
  }
  if (res.status === 403) {
    console.warn(`[claim] GitHub 403 on /repos/${owner}/${name} — token stale or scope missing`);
    return { ok: false, kind: "token_expired" };
  }
  if (!res.ok) {
    console.warn(`[claim] GitHub ${res.status} on /repos/${owner}/${name}`);
    return { ok: false, kind: "upstream_unavailable" };
  }
  const raw = (await res.json().catch(() => null)) as {
    id?: number;
    full_name?: string;
    name?: string;
    owner?: { login?: string };
    private?: boolean;
  } | null;
  if (!raw || typeof raw.id !== "number" || !raw.full_name || !raw.name || !raw.owner?.login) {
    console.warn(`[claim] malformed body from /repos/${owner}/${name}`);
    return { ok: false, kind: "upstream_unavailable" };
  }
  return {
    ok: true,
    repo: {
      githubId: raw.id,
      fullName: raw.full_name,
      owner: raw.owner.login,
      name: raw.name,
      private: raw.private ?? false,
    },
  };
}

async function verifyRepoAccessWithGitHubAppUserToken(
  token: string,
  owner: string,
  name: string,
): Promise<VerifyOutcome> {
  const normalizedFullName = `${owner}/${name}`.toLowerCase();
  let url: string | null = "https://api.github.com/user/installations?per_page=100";

  while (url) {
    let installationsRes: Response;
    try {
      installationsRes = await fetch(url, { headers: githubAppUserHeaders(token) });
    } catch (err) {
      console.warn("[claim] fetch /user/installations threw:", (err as Error).message);
      return { ok: false, kind: "upstream_unavailable" };
    }

    if (installationsRes.status === 401 || installationsRes.status === 403) {
      console.warn(
        `[claim] GitHub ${installationsRes.status} on /user/installations — GitHub App user token stale or unauthorized`,
      );
      return { ok: false, kind: "github_app_required" };
    }
    if (!installationsRes.ok) {
      console.warn(`[claim] GitHub ${installationsRes.status} on /user/installations`);
      return { ok: false, kind: "upstream_unavailable" };
    }

    const installationsBody = (await installationsRes.json().catch(() => null)) as {
      installations?: Array<{
        id?: number;
        suspended_at?: string | null;
        app_slug?: string;
      }>;
    } | null;
    const installations =
      installationsBody?.installations?.filter(
        (installation) =>
          typeof installation.id === "number" &&
          !installation.suspended_at &&
          (!config.githubAppSlug || installation.app_slug === config.githubAppSlug),
      ) ?? [];

    for (const installation of installations) {
      const outcome = await findRepoInGitHubAppInstallation(
        token,
        installation.id!,
        normalizedFullName,
      );
      if (outcome.ok) return outcome;
      if (outcome.kind !== "no_access") return outcome;
    }

    url = parseNextUrl(installationsRes.headers.get("link"));
  }

  return { ok: false, kind: "no_access" };
}

async function findRepoInGitHubAppInstallation(
  token: string,
  installationId: number,
  normalizedFullName: string,
): Promise<VerifyOutcome> {
  let url: string | null =
    `https://api.github.com/user/installations/${installationId}/repositories?per_page=100`;
  while (url) {
    let res: Response;
    try {
      res = await fetch(url, { headers: githubAppUserHeaders(token) });
    } catch (err) {
      console.warn(
        `[claim] fetch /user/installations/${installationId}/repositories threw:`,
        (err as Error).message,
      );
      return { ok: false, kind: "upstream_unavailable" };
    }

    if (res.status === 404) return { ok: false, kind: "no_access" };
    if (res.status === 401 || res.status === 403) {
      console.warn(
        `[claim] GitHub ${res.status} on /user/installations/${installationId}/repositories — GitHub App user token stale or unauthorized`,
      );
      return { ok: false, kind: "github_app_required" };
    }
    if (!res.ok) {
      console.warn(
        `[claim] GitHub ${res.status} on /user/installations/${installationId}/repositories`,
      );
      return { ok: false, kind: "upstream_unavailable" };
    }

    const body = (await res.json().catch(() => null)) as { repositories?: RawGithubRepo[] } | null;
    const repositories = body?.repositories ?? [];
    const match = repositories.find((repo) => repo.full_name?.toLowerCase() === normalizedFullName);
    if (match) {
      const repo = verifiedRepoFromRaw(match);
      if (!repo) {
        console.warn(
          `[claim] malformed repository body from /user/installations/${installationId}/repositories`,
        );
        return { ok: false, kind: "upstream_unavailable" };
      }
      return { ok: true, repo };
    }
    url = parseNextUrl(res.headers.get("link"));
  }

  return { ok: false, kind: "no_access" };
}

function verifiedRepoFromRaw(raw: RawGithubRepo): VerifiedRepo | null {
  if (typeof raw.id !== "number" || !raw.full_name || !raw.name || !raw.owner?.login) {
    return null;
  }
  return {
    githubId: raw.id,
    fullName: raw.full_name,
    owner: raw.owner.login,
    name: raw.name,
    private: raw.private ?? false,
  };
}

async function fetchUserGithubToken(db: Database, userId: number): Promise<string | null> {
  const [row] = await db
    .select({ githubToken: users.githubToken })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.githubToken) return null;
  try {
    return await decryptGithubToken(row.githubToken, config.encryptionKey);
  } catch {
    return null;
  }
}

/** Standard headers for every user-token GitHub API call. Exported so the
 *  one-shot `scripts/reverify-claims.ts` uses the same shape. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `token ${token}`,
    "User-Agent": "slashtalk",
  };
}

function githubAppUserHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
    "User-Agent": "slashtalk",
  };
}

interface RawGithubOrg {
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface RawGithubRepo {
  id?: number;
  name?: string;
  full_name?: string;
  owner?: { login?: string };
  private?: boolean;
  archived?: boolean;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  };
  role_name?: string;
}

function parseNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Link: <https://…?page=2>; rel="next", <https://…?page=N>; rel="last"
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m && m[2] === "next") return m[1];
  }
  return null;
}

function permissionFromRepo(r: RawGithubRepo): OrgRepo["permission"] {
  if (r.permissions?.admin) return "admin";
  if (r.permissions?.maintain) return "maintain";
  if (r.permissions?.push) return "push";
  if (r.permissions?.triage) return "triage";
  return "pull";
}

export const userRoutes = (db: Database) =>
  new Elysia({ prefix: "/api/me", name: "user" })
    .use(jwtAuth)

    // GET /api/me — current user profile
    .get("/", ({ user }) => ({
      id: user.id,
      githubLogin: user.githubLogin,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      createdAt: user.createdAt,
    }))

    // GET /api/me/devices — list user's devices
    .get("/devices", async ({ user }) => {
      return await db.select().from(devices).where(eq(devices.userId, user.id));
    })

    // DELETE /api/me/devices/:id — remove a device + its API key
    .delete(
      "/devices/:id",
      async ({ params, user, set }) => {
        const [device] = await db
          .select()
          .from(devices)
          .where(and(eq(devices.id, Number(params.id)), eq(devices.userId, user.id)))
          .limit(1);

        if (!device) {
          set.status = 404;
          return { error: "Device not found" };
        }

        await db.delete(apiKeys).where(eq(apiKeys.deviceId, device.id));
        await db.delete(devices).where(eq(devices.id, device.id));
        authAudit("device_credentials_revoked", {
          userId: user.id,
          deviceId: device.id,
          scope: "device",
        });

        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    )

    // GET /api/me/repos — list repos the user has claimed
    .get("/repos", async ({ user }) => {
      return await db
        .select({
          repoId: repos.id,
          fullName: repos.fullName,
          owner: repos.owner,
          name: repos.name,
          private: repos.private,
          permission: userRepos.permission,
          syncedAt: userRepos.syncedAt,
        })
        .from(userRepos)
        .innerJoin(repos, eq(repos.id, userRepos.repoId))
        .where(eq(userRepos.userId, user.id));
    })

    // POST /api/me/repos — claim a repo by "owner/name". See
    // docs/SECURITY.md § Repo-claim verification and core-beliefs §§ 11-13.
    .post(
      "/repos",
      async ({ user, body, set }) => {
        const raw = body.fullName.trim();
        if (!FULL_NAME.test(raw)) {
          set.status = 400;
          return {
            error: "invalid_full_name",
            message: "fullName must be in owner/name form",
          };
        }

        if (!recordClaimAttempt(user.id)) {
          set.status = 429;
          return {
            error: "rate_limited",
            message: `Too many claim attempts. Limit is ${CLAIM_RATE_MAX} per hour.`,
          };
        }

        const normalizedFullName = normalizeFullName(raw);
        const [rawOwner, rawName] = raw.split("/");

        // Cache lookup: a desktop double-click or retry shouldn't double-hit
        // GitHub. Keyed by (userId, lowercased fullName) — GitHub's repo
        // namespace is case-insensitive. Stale entries are dropped on access.
        const cacheKey = `${user.id}:${normalizedFullName}`;
        const cached = claimVerifyCache.get(cacheKey);
        let verified: VerifiedRepo | null = null;
        if (cached) {
          if (Date.now() - cached.at < CLAIM_VERIFY_TTL_MS) {
            verified = cached.value;
          } else {
            claimVerifyCache.delete(cacheKey);
          }
        }

        if (!verified) {
          const token = await fetchUserGithubToken(db, user.id);
          if (!token) {
            set.status = 401;
            return {
              error: "token_expired",
              message: "Re-sign in to slashtalk.",
            };
          }
          let outcome = await verifyRepoAccess(token, rawOwner, rawName);
          let checkedGitHubApp = false;
          if (!outcome.ok && outcome.kind === "no_access") {
            const appToken = await fetchUserGithubAppToken(db, user.id);
            if (appToken.ok) {
              checkedGitHubApp = true;
              outcome = await verifyRepoAccessWithGitHubAppUserToken(
                appToken.token,
                rawOwner,
                rawName,
              );
            } else if (isGithubAppConfigured()) {
              outcome = { ok: false, kind: "github_app_required" };
            }
          }
          if (!outcome.ok) {
            if (outcome.kind === "github_app_required") {
              set.status = 403;
              return {
                error: "no_access",
                message:
                  "Private repo access needs the Slashtalk GitHub App. Complete the browser setup, then click Add local repo again.",
                requiresGithubApp: true,
                connectUrl: githubAppConnectUrlForUser(user.id),
              };
            }
            if (outcome.kind === "no_access") {
              const message = checkedGitHubApp
                ? "The Slashtalk GitHub App is not installed on this repo. Open GitHub App settings, include this repository, then try again."
                : "GitHub doesn't show you have access to this repo.";
              set.status = 403;
              return {
                error: "no_access",
                message,
                connectUrl: checkedGitHubApp
                  ? githubAppConnectUrlForUser(user.id, { install: true })
                  : undefined,
              };
            }
            if (outcome.kind === "token_expired") {
              set.status = 401;
              return {
                error: "token_expired",
                message: "Re-sign in to slashtalk.",
              };
            }
            if (outcome.kind === "github_grant_revoked") {
              await revokeAllUserCredentials(db, user.id, "github_grant_revoked");
              set.status = 401;
              return {
                error: "token_expired",
                message: "Re-sign in to slashtalk.",
              };
            }
            set.status = 502;
            return {
              error: "upstream_unavailable",
              message: "Couldn't reach GitHub. Try again.",
            };
          }
          verified = outcome.repo;
          claimVerifyCache.set(cacheKey, { at: Date.now(), value: verified });
        }

        // Use GitHub's canonical casing / numeric id for DB storage. The
        // `repos.fullName` unique constraint is case-sensitive at the SQL
        // level, so we normalize to lowercase to keep dedupe consistent with
        // the rest of the codebase (normalizeFullName everywhere).
        const canonicalFullName = normalizeFullName(verified.fullName);
        const [repo] = await db
          .insert(repos)
          .values({
            fullName: canonicalFullName,
            owner: verified.owner,
            name: verified.name,
            private: verified.private,
            githubId: verified.githubId,
          })
          .onConflictDoUpdate({
            target: repos.fullName,
            set: {
              owner: verified.owner,
              name: verified.name,
              private: verified.private,
              githubId: verified.githubId,
            },
          })
          .returning();

        await db
          .insert(userRepos)
          .values({
            userId: user.id,
            repoId: repo.id,
            permission: "claimed",
            syncedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [userRepos.userId, userRepos.repoId],
          });

        return {
          repoId: repo.id,
          fullName: repo.fullName,
          owner: repo.owner,
          name: repo.name,
          private: repo.private ?? false,
          permission: "claimed",
          syncedAt: new Date().toISOString(),
        };
      },
      {
        body: t.Object({
          fullName: t.String({ minLength: 3, maxLength: 140 }),
        }),
      },
    )

    // GET /api/me/github-app/status — whether this user has linked the
    // narrow GitHub App repo-access grant used for private repo claims.
    .get("/github-app/status", async ({ user }) => {
      const status = await githubAppConnectionStatus(db, user.id);
      return {
        ...status,
        installUrl: status.configured ? githubAppInstallUrl() : null,
        connectUrl: status.configured ? githubAppConnectUrlForUser(user.id) : githubAppConnectUrl(),
      };
    })

    // DELETE /api/me/repos/:repoId — stop tracking a repo
    .delete(
      "/repos/:repoId",
      async ({ user, params }) => {
        await db
          .delete(userRepos)
          .where(and(eq(userRepos.userId, user.id), eq(userRepos.repoId, Number(params.repoId))));
        return { ok: true };
      },
      { params: t.Object({ repoId: t.String() }) },
    )

    // POST /api/me/setup-token — generate a new setup token
    .post("/setup-token", async ({ user }) => {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await db.insert(setupTokens).values({
        userId: user.id,
        token,
        expiresAt,
      });

      return { token, expiresAt: expiresAt.toISOString() };
    })

    // GET /api/me/orgs — orgs the signed-in user belongs to, proxied from
    // GitHub using the stored OAuth token. Returns [] when the token is
    // missing, dead, or rate-limited — the desktop treats "no orgs" as the
    // tray-popup empty state rather than an error.
    .get("/orgs", async ({ user }): Promise<OrgSummary[]> => {
      const cached = orgsCache.get(user.id);
      if (cached && Date.now() - cached.at < ORGS_TTL_MS) return cached.value;

      const token = await fetchUserGithubToken(db, user.id);
      if (!token) return [];

      let res: Response;
      try {
        res = await fetch("https://api.github.com/user/orgs?per_page=100", {
          headers: githubHeaders(token),
        });
      } catch {
        return [];
      }
      if (res.status === 401) {
        await revokeAllUserCredentials(db, user.id, "github_grant_revoked");
        return [];
      }
      if (res.status === 403) return [];
      if (!res.ok) return [];

      const raw = (await res.json().catch(() => null)) as RawGithubOrg[] | null;
      if (!Array.isArray(raw)) return [];

      const value: OrgSummary[] = raw
        .filter((o): o is RawGithubOrg & { login: string } => !!o.login)
        .map((o) => ({
          login: o.login,
          name: o.name ?? null,
          avatarUrl: o.avatar_url ?? "",
        }));
      orgsCache.set(user.id, { at: Date.now(), value });
      return value;
    })

    // GET /api/me/orgs/:org/repos — repos in `:org` readable by the signed-in
    // user. Uses /orgs/{org}/repos which (with a user token) already filters
    // to repos the user can access. Archived repos are skipped. Caps at 5
    // pages = 500 repos so a pathological org can't pin this request.
    .get(
      "/orgs/:org/repos",
      async ({ params, user, set }): Promise<OrgRepo[]> => {
        const org = params.org.trim();
        if (!ORG_LOGIN.test(org)) {
          set.status = 400;
          return [];
        }

        const cacheKey = `${user.id}:${org}`;
        const cached = orgReposCache.get(cacheKey);
        if (cached && Date.now() - cached.at < ORGS_TTL_MS) return cached.value;

        const token = await fetchUserGithubToken(db, user.id);
        if (!token) return [];

        const collected: OrgRepo[] = [];
        let url: string | null =
          `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=100&type=all&sort=updated`;
        let pages = 0;
        const MAX_PAGES = 5;

        while (url && pages < MAX_PAGES) {
          pages += 1;
          let res: Response;
          try {
            res = await fetch(url, { headers: githubHeaders(token) });
          } catch {
            return [];
          }
          if (res.status === 401) {
            await revokeAllUserCredentials(db, user.id, "github_grant_revoked");
            return [];
          }
          if (res.status === 403) return [];
          if (res.status === 404) return [];
          if (!res.ok) return [];

          const raw = (await res.json().catch(() => null)) as RawGithubRepo[] | null;
          if (!Array.isArray(raw)) break;

          for (const r of raw) {
            if (r.archived) continue;
            if (typeof r.id !== "number") continue;
            if (!r.full_name || !r.name || !r.owner?.login) continue;
            collected.push({
              repoId: r.id,
              fullName: r.full_name,
              name: r.name,
              owner: r.owner.login,
              private: r.private ?? false,
              permission: permissionFromRepo(r),
            });
          }

          url = parseNextUrl(res.headers.get("link"));
        }

        orgReposCache.set(cacheKey, { at: Date.now(), value: collected });
        return collected;
      },
      { params: t.Object({ org: t.String() }) },
    );

/**
 * Device repos management — reported by install script.
 * Mounted separately at /v1/devices prefix.
 */
export const deviceReposRoutes = (db: Database) =>
  new Elysia({ prefix: "/v1/devices", name: "device-repos" })
    .use(
      // Use API key auth (imported inline to avoid circular dep)
      new Elysia({ name: "device-repos/auth" }).derive(
        { as: "scoped" },
        async ({ headers, set }) => {
          const { apiKeyAuth } = await import("../auth/middleware");
          // Reuse the apiKeyAuth derive logic inline
          const authHeader = headers.authorization;
          if (!authHeader?.startsWith("Bearer ")) {
            set.status = 401;
            throw new Error("Missing API key");
          }
          const { hashToken } = await import("../auth/tokens");
          const key = authHeader.slice(7);
          const keyHash = await hashToken(key);
          const [apiKey] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.keyHash, keyHash))
            .limit(1);
          if (!apiKey) {
            set.status = 401;
            throw new Error("Invalid API key");
          }
          const [user] = await db.select().from(users).where(eq(users.id, apiKey.userId)).limit(1);
          if (!user) {
            set.status = 401;
            throw new Error("User not found");
          }
          const [device] = await db
            .select()
            .from(devices)
            .where(eq(devices.id, apiKey.deviceId))
            .limit(1);
          return { user, device: device ?? null };
        },
      ),
    )

    // GET /v1/devices/:id/repos — the paths this device has registered.
    // Used by the desktop on sign-in to rehydrate its tracked-repo list.
    .get(
      "/:id/repos",
      async ({ params, user, set }) => {
        const deviceId = Number(params.id);
        const [dev] = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
          .limit(1);
        if (!dev) {
          set.status = 404;
          return { error: "Device not found" };
        }
        const rows = await db
          .select({
            repoId: repos.id,
            fullName: repos.fullName,
            localPath: deviceRepoPaths.localPath,
          })
          .from(deviceRepoPaths)
          .innerJoin(repos, eq(repos.id, deviceRepoPaths.repoId))
          .where(eq(deviceRepoPaths.deviceId, deviceId));
        return rows;
      },
      { params: t.Object({ id: t.String() }) },
    )

    // POST /v1/devices/:id/repos — set repo paths and exclusions for a device
    .post(
      "/:id/repos",
      async ({ params, body, user, set }) => {
        const deviceId = Number(params.id);

        // Verify device belongs to user
        const [dev] = await db
          .select()
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
          .limit(1);

        if (!dev) {
          set.status = 404;
          return { error: "Device not found" };
        }

        const visibleRepos = await db
          .select({ repoId: repos.id, fullName: repos.fullName })
          .from(userRepos)
          .innerJoin(repos, eq(repos.id, userRepos.repoId))
          .where(eq(userRepos.userId, user.id));

        const repoIdByFullName = new Map(visibleRepos.map((repo) => [repo.fullName, repo.repoId]));
        const visibleRepoIds = new Set(visibleRepos.map((repo) => repo.repoId));
        const skippedRepos: string[] = [];

        const resolveRepoId = (input: {
          repoId?: number;
          fullName?: string;
          repoFullName?: string;
        }): number | null => {
          if (typeof input.repoId === "number" && visibleRepoIds.has(input.repoId)) {
            return input.repoId;
          }

          const fullName = input.fullName ?? input.repoFullName;
          if (fullName) {
            return repoIdByFullName.get(normalizeFullName(fullName)) ?? null;
          }

          return null;
        };

        // Store local path → repo mappings (from install-time discovery)
        let repoPathsStored = 0;
        await db.delete(deviceRepoPaths).where(eq(deviceRepoPaths.deviceId, deviceId));

        if (body.repoPaths !== undefined) {
          const repoPathsByRepoId = new Map<number, string>();
          for (const repoPath of body.repoPaths) {
            const repoId = resolveRepoId(repoPath);
            if (!repoId) {
              skippedRepos.push(
                repoPath.fullName ??
                  repoPath.repoFullName ??
                  `repoId:${repoPath.repoId ?? "unknown"}`,
              );
              continue;
            }
            repoPathsByRepoId.set(repoId, repoPath.localPath);
          }

          const normalizedRepoPaths = Array.from(repoPathsByRepoId.entries()).map(
            ([repoId, localPath]) => ({
              deviceId,
              repoId,
              localPath,
            }),
          );

          repoPathsStored = normalizedRepoPaths.length;
          if (normalizedRepoPaths.length > 0) {
            await db.insert(deviceRepoPaths).values(normalizedRepoPaths);
          }
        }

        // Store exclusions
        await db.delete(deviceExcludedRepos).where(eq(deviceExcludedRepos.deviceId, deviceId));

        const excludedRepoIds = new Set<number>();
        for (const repoId of body.excludedRepoIds ?? []) {
          if (visibleRepoIds.has(repoId)) {
            excludedRepoIds.add(repoId);
          } else {
            skippedRepos.push(`repoId:${repoId}`);
          }
        }
        for (const fullName of body.excludedRepos ?? []) {
          const repoId = repoIdByFullName.get(normalizeFullName(fullName));
          if (repoId) {
            excludedRepoIds.add(repoId);
          } else {
            skippedRepos.push(fullName);
          }
        }
        for (const fullName of body.excludedRepoFullNames ?? []) {
          const repoId = repoIdByFullName.get(normalizeFullName(fullName));
          if (repoId) {
            excludedRepoIds.add(repoId);
          } else {
            skippedRepos.push(fullName);
          }
        }

        const excludedReposStored = excludedRepoIds.size;
        if (excludedReposStored > 0) {
          await db.insert(deviceExcludedRepos).values(
            Array.from(excludedRepoIds).map((repoId) => ({
              deviceId,
              repoId,
            })),
          );
        }

        if (excludedRepoIds.size > 0) {
          const excludedSessions = await db
            .select({ sessionId: sessions.sessionId })
            .from(sessions)
            .where(
              and(
                eq(sessions.userId, user.id),
                eq(sessions.deviceId, deviceId),
                inArray(sessions.repoId, Array.from(excludedRepoIds)),
              ),
            );

          for (const session of excludedSessions) {
            await db
              .update(sessions)
              .set({ repoId: null })
              .where(eq(sessions.sessionId, session.sessionId));
          }
        }

        const unmatchedSessions = await db
          .select({
            sessionId: sessions.sessionId,
            cwd: sessions.cwd,
            project: sessions.project,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, user.id),
              eq(sessions.deviceId, deviceId),
              isNull(sessions.repoId),
            ),
          );

        for (const session of unmatchedSessions) {
          const repoId = await matchSessionRepo(
            db,
            user.id,
            session.cwd,
            session.project,
            deviceId,
          );
          if (!repoId) continue;

          await db
            .update(sessions)
            .set({ repoId })
            .where(and(eq(sessions.sessionId, session.sessionId), isNull(sessions.repoId)));
        }

        return {
          ok: true,
          repoPathsStored,
          excludedReposStored,
          skippedRepos,
        };
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          repoPaths: t.Optional(
            t.Array(
              t.Object({
                repoId: t.Optional(t.Number()),
                fullName: t.Optional(t.String()),
                repoFullName: t.Optional(t.String()),
                localPath: t.String(),
              }),
            ),
          ),
          excludedRepoIds: t.Optional(t.Array(t.Number())),
          excludedRepos: t.Optional(t.Array(t.String())),
          excludedRepoFullNames: t.Optional(t.Array(t.String())),
        }),
      },
    );
