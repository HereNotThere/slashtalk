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

export async function fetchUserGithubToken(
  db: Database,
  userId: number,
): Promise<string | null> {
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
