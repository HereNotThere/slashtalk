// Lazy refresher for user_orgs. Calls GET /user/memberships/orgs?state=active
// (in-scope of read:user read:org per CLAUDE.md #11) and upserts the result.
// Stale rows trigger a re-fetch; otherwise we serve from the table.

import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { userOrgs } from "../db/schema";
import { config } from "../config";
import { fetchUserGithubToken, githubHeaders } from "../user/github-helpers";

interface RawMembership {
  state?: string;
  role?: string;
  organization?: { login?: string };
}

export async function refreshUserOrgs(db: Database, userId: number): Promise<string[]> {
  const existing = await db.select().from(userOrgs).where(eq(userOrgs.userId, userId));
  const stalest =
    existing.length === 0 ? 0 : Math.min(...existing.map((r) => r.refreshedAt?.getTime() ?? 0));
  const fresh = existing.length > 0 && Date.now() - stalest < config.orgMembershipRefreshMs;
  if (fresh) return existing.map((r) => r.orgLogin);

  const token = await fetchUserGithubToken(db, userId);
  if (!token) return existing.map((r) => r.orgLogin);

  let res: Response;
  try {
    res = await fetch("https://api.github.com/user/memberships/orgs?state=active&per_page=100", {
      headers: githubHeaders(token),
    });
  } catch {
    return existing.map((r) => r.orgLogin);
  }
  if (!res.ok) return existing.map((r) => r.orgLogin);

  const raw = (await res.json().catch(() => null)) as RawMembership[] | null;
  if (!Array.isArray(raw)) return existing.map((r) => r.orgLogin);

  const memberships = raw
    .filter(
      (m): m is RawMembership & { organization: { login: string } } =>
        m.state === "active" && !!m.organization?.login,
    )
    .map((m) => ({ orgLogin: m.organization.login, role: m.role ?? null }));

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(userOrgs).where(eq(userOrgs.userId, userId));
    if (memberships.length > 0) {
      await tx.insert(userOrgs).values(
        memberships.map((m) => ({
          userId,
          orgLogin: m.orgLogin,
          role: m.role,
          refreshedAt: now,
        })),
      );
    }
  });

  return memberships.map((m) => m.orgLogin);
}

export async function userIsInOrg(
  db: Database,
  userId: number,
  orgLogin: string,
): Promise<boolean> {
  const orgs = await refreshUserOrgs(db, userId);
  return orgs.includes(orgLogin);
}
