// Repo-claim verification + the /api/me/repos resource.
//
// CLAUDE.md core-belief #12: "Repo access is verified, not asserted." Every
// claim does a `GET /repos/:owner/:name` against the user's stored OAuth
// token before inserting a `user_repos` row. See docs/SECURITY.md
// § Repo-claim verification for the full flow.
//
// Owns:
// - the per-(user, fullName) verification cache (dedup desktop double-clicks)
// - the per-user claim-attempt rate limit (block enumeration via stolen JWT)
// - the OAuth verification call

import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import { repos, userRepos } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { githubFetch } from "../auth/github-fetch";
import { revokeAllUserCredentials } from "../auth/sessions";
import { normalizeFullName } from "../social/github-sync";
import { TtlCache } from "../util/ttl-cache";
import { fetchUserGithubToken, githubHeaders } from "./github-helpers";

// "owner/name" — GitHub's constraints apply: 1-39 chars for owner, 1-100 for name.
const FULL_NAME = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Claim-verification cache: dedups a repeated `GET /repos/:owner/:name` for
// the same (user, fullName) pair (desktop double-clicks, retry-on-failure).
// Keyed by `${userId}:${fullName-lower}`.
const CLAIM_VERIFY_TTL_MS = 60_000;
const claimVerifyCache = new TtlCache<string, VerifiedRepo>(CLAIM_VERIFY_TTL_MS);

// Per-user rate-limit for `POST /api/me/repos`. Blocks an adversary with a
// stolen JWT from enumerating private repos by brute-forcing fullNames.
// Token-bucket, in-memory only (sufficient for single-node deploy; revisit
// if we go multi-node before shipping a durable store).
const CLAIM_RATE_WINDOW_MS = 60 * 60 * 1000;
const CLAIM_RATE_MAX = 30;
const claimRateBuckets = new Map<number, number[]>();
const RATE_SWEEP_THRESHOLD = 5_000;

function sweepClaimRateBuckets(now: number): void {
  if (claimRateBuckets.size < RATE_SWEEP_THRESHOLD) return;
  const rateCutoff = now - CLAIM_RATE_WINDOW_MS;
  for (const [userId, ts] of claimRateBuckets) {
    const fresh = ts.filter((t) => t > rateCutoff);
    if (fresh.length === 0) claimRateBuckets.delete(userId);
    else if (fresh.length !== ts.length) claimRateBuckets.set(userId, fresh);
  }
}

/** Test-only: reset claim caches + rate-bucket state. */
export function __clearClaimCaches(): void {
  claimVerifyCache.clear();
  claimRateBuckets.clear();
}

/** Returns true if `userId` is under the per-hour claim cap; records the
 *  attempt as a side-effect. Trims stale timestamps opportunistically; drops
 *  the bucket entirely when no fresh entries remain so dormant users don't
 *  linger in memory forever. */
function recordClaimAttempt(userId: number): boolean {
  const now = Date.now();
  sweepClaimRateBuckets(now);
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
      kind: "no_access" | "github_grant_revoked" | "token_expired" | "upstream_unavailable";
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
  const path = `/repos/${owner}/${name}`;
  const result = await githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { headers: githubHeaders(token) },
    `claim ${path}`,
  );
  if (!result.ok) {
    if (result.reason === "not_found") return { ok: false, kind: "no_access" };
    if (result.reason === "unauthorized") return { ok: false, kind: "github_grant_revoked" };
    if (result.reason === "forbidden") return { ok: false, kind: "token_expired" };
    return { ok: false, kind: "upstream_unavailable" };
  }
  const raw = (await result.res.json().catch(() => null)) as {
    id?: number;
    full_name?: string;
    name?: string;
    owner?: { login?: string };
    private?: boolean;
  } | null;
  if (!raw || typeof raw.id !== "number" || !raw.full_name || !raw.name || !raw.owner?.login) {
    console.warn(`[claim ${path}] malformed body`);
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

export const claimRoutes = (db: Database) =>
  new Elysia({ prefix: "/api/me", name: "users/claim" })
    .use(jwtAuth)

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
        let verified: VerifiedRepo | null = claimVerifyCache.get(cacheKey) ?? null;

        if (!verified) {
          const token = await fetchUserGithubToken(db, user.id);
          if (!token) {
            set.status = 401;
            return {
              error: "token_expired",
              message: "Re-sign in to slashtalk.",
            };
          }
          const outcome = await verifyRepoAccess(token, rawOwner, rawName);
          if (!outcome.ok) {
            if (outcome.kind === "no_access") {
              set.status = 403;
              return {
                error: "no_access",
                message: "GitHub doesn't show you have access to this repo.",
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
          claimVerifyCache.set(cacheKey, verified);
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
    );
