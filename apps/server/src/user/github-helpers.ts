// Shared helpers for the user-OAuth-token-flavored GitHub API calls under
// /api/me/*. Both the claim-verification path (POST /api/me/repos) and the
// orgs-proxy paths (GET /api/me/orgs, GET /api/me/orgs/:org/repos) use the
// same headers, the same token-fetch, and the same `Link: rel="next"`
// pagination shape — keep them in one place so additions stay consistent.

import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { users } from "../db/schema";
import { config } from "../config";
import { decryptGithubToken } from "../auth/tokens";
import { revokeAllUserCredentials } from "../auth/sessions";
import { githubFetch } from "../auth/github-fetch";
import { TtlCache } from "../util/ttl-cache";

/** Standard headers for every user-token GitHub API call. Exported so the
 *  one-shot `scripts/reclassify-by-org.ts` uses the same shape. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `token ${token}`,
    "User-Agent": "slashtalk",
  };
}

export async function fetchUserGithubToken(db: Database, userId: number): Promise<string | null> {
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

/** Subset of the GitHub `repository` schema we actually consume. Optional
 *  everywhere because GitHub's response shapes shift across endpoint families
 *  (search vs. installation vs. orgs/:org/repos) and we'd rather narrow at
 *  the use site than fail-closed on a schema we don't fully control. */
export interface RawGithubRepo {
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

/** Parse the `Link: <…>; rel="next"` header GitHub returns on paginated
 *  endpoints. Returns the next-page URL or null when this is the last page. */
export function parseNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Link: <https://…?page=2>; rel="next", <https://…?page=N>; rel="last"
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m && m[2] === "next") return m[1];
  }
  return null;
}

// ── Org-membership lookup (claim-gate authoritative source) ──────────────

export type OrgMembershipsOutcome =
  | { ok: true; orgs: string[] }
  | { ok: false; kind: "token_expired" | "upstream_unavailable" };

const ORG_MEMBERSHIPS_TTL_MS = 60_000;
const ORG_MEMBERSHIPS_PAGE_CAP = 5;
const orgMembershipsCache = new TtlCache<number, string[]>(ORG_MEMBERSHIPS_TTL_MS);

/** Test-only: reset the org-memberships cache so assertions don't bleed. */
export function __clearOrgMembershipsCache(): void {
  orgMembershipsCache.clear();
}

/**
 * Lists the user's *active* org memberships from `GET /user/memberships/orgs`.
 * Returns lowercased org logins so the claim path can `Set.has`-match against
 * `owner`. `state=active` filters out pending invitations — a pending invite
 * shouldn't grant claim authority.
 *
 * Auth: requires the user's stored OAuth token (`read:org` scope). On `401`
 * we revoke all credentials (mirrors the existing claim path's stale-token
 * recovery); on `403`, `5xx`, or network failure we return `upstream_unavailable`
 * so the caller can fail closed without invalidating the session.
 *
 * Note: orgs that have third-party OAuth restrictions and have not approved
 * slashtalk are silently absent from the response. We can't distinguish that
 * from "user is not a member" — surface the OAuth-app-restriction possibility
 * in the caller's error message.
 */
export async function fetchUserOrgMemberships(
  db: Database,
  userId: number,
): Promise<OrgMembershipsOutcome> {
  const cached = orgMembershipsCache.get(userId);
  if (cached) return { ok: true, orgs: cached };

  const [row] = await db
    .select({ githubToken: users.githubToken })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.githubToken) return { ok: false, kind: "token_expired" };

  let token: string;
  try {
    token = await decryptGithubToken(row.githubToken, config.encryptionKey);
  } catch {
    return { ok: false, kind: "token_expired" };
  }

  const collected: string[] = [];
  let url: string | null = "https://api.github.com/user/memberships/orgs?state=active&per_page=100";
  let pages = 0;

  while (url && pages < ORG_MEMBERSHIPS_PAGE_CAP) {
    pages += 1;
    const result = await githubFetch(
      url,
      { headers: githubHeaders(token) },
      "claim /user/memberships/orgs",
    );
    if (!result.ok) {
      if (result.reason === "unauthorized") {
        await revokeAllUserCredentials(db, userId, "github_grant_revoked");
        return { ok: false, kind: "token_expired" };
      }
      return { ok: false, kind: "upstream_unavailable" };
    }
    const body = (await result.res.json().catch(() => null)) as Array<{
      state?: string;
      organization?: { login?: string };
    }> | null;
    if (!Array.isArray(body)) {
      console.warn("[claim /user/memberships/orgs] malformed body");
      return { ok: false, kind: "upstream_unavailable" };
    }
    for (const m of body) {
      if (m.state !== "active") continue;
      const login = m.organization?.login;
      if (typeof login === "string" && login.length > 0) collected.push(login.toLowerCase());
    }
    url = parseNextUrl(result.res.headers.get("link"));
  }

  orgMembershipsCache.set(userId, collected);
  return { ok: true, orgs: collected };
}
