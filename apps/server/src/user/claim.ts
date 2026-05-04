// Repo-claim verification + the /api/me/repos resource.
//
// CLAUDE.md core-belief #12: "Repo access is verified, not asserted." A claim
// is accepted only when the caller is an active GitHub member of the repo's
// owning org, or when the repo is in the caller's own personal namespace
// (`owner === user.githubLogin`). No `GET /repos/:owner/:name` call, no
// GitHub App fallback. See docs/SECURITY.md § Repo-claim verification.
//
// Owns:
// - the per-user claim-attempt rate limit (block enumeration via stolen JWT)
// - the gate logic for POST /api/me/repos
//
// The org-membership lookup itself (with its own 60s TTL cache) lives in
// `github-helpers.ts::fetchUserOrgMemberships` so the orgs proxy and the
// claim path can share invalidation if we ever add it.

import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import { repos, userRepos } from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { normalizeFullName } from "../social/github-sync";
import { SlidingWindowRateLimiter } from "../util/rate-limit";
import { __clearOrgMembershipsCache, fetchUserOrgMemberships } from "./github-helpers";

// "owner/name" — GitHub's constraints apply: 1-39 chars for owner, 1-100 for name.
const FULL_NAME = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Per-user rate-limit for `POST /api/me/repos`. Generic abuse guard; under the
// org-or-self gate, an attacker with a stolen JWT can only claim repos in the
// legitimate user's orgs (no enumeration surface), but the limit still bounds
// CPU + DB writes per session.
const CLAIM_RATE_WINDOW_MS = 60 * 60 * 1000;
const CLAIM_RATE_MAX = 30;
const RATE_SWEEP_THRESHOLD = 5_000;
const claimRateLimiter = new SlidingWindowRateLimiter<number>({
  max: CLAIM_RATE_MAX,
  windowMs: CLAIM_RATE_WINDOW_MS,
  sweepThreshold: RATE_SWEEP_THRESHOLD,
});

/** Test-only: reset claim caches + rate-bucket state. */
export function __clearClaimCaches(): void {
  __clearOrgMembershipsCache();
  claimRateLimiter.clear();
}

/** Returns true if `userId` is under the per-hour claim cap; records the
 *  attempt as a side-effect. Trims stale timestamps opportunistically; drops
 *  the bucket entirely when no fresh entries remain so dormant users don't
 *  linger in memory forever. */
function recordClaimAttempt(userId: number): boolean {
  return claimRateLimiter.record(userId).ok;
}

type VerifyOutcome =
  | { ok: true }
  | { ok: false; kind: "no_access" | "token_expired" | "upstream_unavailable" };

/** The claim gate. Accepts iff `owner` is the caller's own GitHub login
 *  (personal namespace, no GitHub call) OR appears in the caller's active
 *  org memberships from `/user/memberships/orgs?state=active`. */
async function verifyOrgOrSelf(
  db: Database,
  userId: number,
  userLogin: string,
  owner: string,
): Promise<VerifyOutcome> {
  if (owner.toLowerCase() === userLogin.toLowerCase()) {
    return { ok: true };
  }
  const result = await fetchUserOrgMemberships(db, userId);
  if (!result.ok) return { ok: false, kind: result.kind };
  const ownerLower = owner.toLowerCase();
  if (result.orgs.includes(ownerLower)) return { ok: true };
  return { ok: false, kind: "no_access" };
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
    // docs/SECURITY.md § Repo-claim verification and core-beliefs §§ 11–12.
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

        const [rawOwner, rawName] = raw.split("/");
        const outcome = await verifyOrgOrSelf(db, user.id, user.githubLogin, rawOwner);

        if (!outcome.ok) {
          if (outcome.kind === "no_access") {
            set.status = 403;
            return {
              error: "no_access",
              message:
                "GitHub doesn't show this repo in your orgs. If your org restricts OAuth apps, an admin may need to approve slashtalk.",
            };
          }
          if (outcome.kind === "token_expired") {
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

        // No `GET /repos/:owner/:name` call, so we don't have GitHub's
        // canonical metadata for new claims. Use lowercased fullName for
        // dedupe (case-insensitive on GitHub) and preserve user-input
        // owner/name casing on insert. On re-claim, leave the existing row
        // as-is — otherwise two collaborators with different casing
        // (`Vercel/Next.js` vs `vercel/next.js`) thrash the displayed
        // metadata on every claim. First-claim-wins is good enough.
        const canonicalFullName = normalizeFullName(raw);
        await db
          .insert(repos)
          .values({
            fullName: canonicalFullName,
            owner: rawOwner,
            name: rawName,
          })
          .onConflictDoNothing({ target: repos.fullName });
        const [repo] = await db
          .select()
          .from(repos)
          .where(eq(repos.fullName, canonicalFullName))
          .limit(1);

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
