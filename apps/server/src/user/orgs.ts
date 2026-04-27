// GET /api/me/orgs and GET /api/me/orgs/:org/repos — proxied lookups against
// the user's stored OAuth token. Both paths cache for 60s because the tray
// popup opens/closes repeatedly and hitting GitHub each time would burn
// rate-limit and feel slow. /orgs/:org/repos caps at 5 pages = 500 repos so
// a pathological org can't pin a single request.

import { Elysia, t } from "elysia";
import type { OrgRepo, OrgSummary } from "@slashtalk/shared";
import type { Database } from "../db";
import { jwtAuth } from "../auth/middleware";
import { revokeAllUserCredentials } from "../auth/sessions";
import { TtlCache } from "../util/ttl-cache";
import {
  type RawGithubRepo,
  fetchUserGithubToken,
  githubHeaders,
  parseNextUrl,
} from "./github-helpers";

// GitHub org login: 1-39 chars of letters, digits, or hyphens.
const ORG_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const TTL_MS = 60_000;
const orgsCache = new TtlCache<number, OrgSummary[]>(TTL_MS);
const orgReposCache = new TtlCache<string, OrgRepo[]>(TTL_MS);

interface RawGithubOrg {
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

function permissionFromRepo(r: RawGithubRepo): OrgRepo["permission"] {
  if (r.permissions?.admin) return "admin";
  if (r.permissions?.maintain) return "maintain";
  if (r.permissions?.push) return "push";
  if (r.permissions?.triage) return "triage";
  return "pull";
}

/** Test-only: reset the proxy caches so assertions don't bleed across cases. */
export function __clearOrgsCaches(): void {
  orgsCache.clear();
  orgReposCache.clear();
}

export const orgsRoutes = (db: Database) =>
  new Elysia({ prefix: "/api/me", name: "users/orgs" })
    .use(jwtAuth)

    // GET /api/me/orgs — orgs the signed-in user belongs to. Returns [] when
    // the token is missing, dead, or rate-limited — the desktop treats "no
    // orgs" as the tray-popup empty state rather than an error.
    .get("/orgs", async ({ user }): Promise<OrgSummary[]> => {
      const cached = orgsCache.get(user.id);
      if (cached) return cached;

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
      orgsCache.set(user.id, value);
      return value;
    })

    // GET /api/me/orgs/:org/repos — repos in `:org` readable by the signed-in
    // user. Uses /orgs/{org}/repos which (with a user token) already filters
    // to repos the user can access. Archived repos are skipped.
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
        if (cached) return cached;

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

        orgReposCache.set(cacheKey, collected);
        return collected;
      },
      { params: t.Object({ org: t.String() }) },
    );
