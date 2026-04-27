#!/usr/bin/env bun
/**
 * Re-evaluates every `user_repos` row against the org-or-self gate
 * introduced by `docs/plans/org-membership-claim-gate.md`. Rows where
 * `owner` is neither (a) in the user's active GitHub org memberships
 * nor (b) equal to the user's own GitHub login are deleted.
 *
 * Replaces `scripts/reverify-claims.ts` (the per-repo `/repos/:owner/:name`
 * verifier) since that mechanism is gone.
 *
 * Run ONCE manually against prod after deploying the new claim gate, before
 * any client starts relying on the stricter authorization. Not wired into
 * the regular deploy pipeline.
 *
 *   cd apps/server && bun run scripts/reclassify-by-org.ts --dry-run
 *     # review output, then:
 *   bun run scripts/reclassify-by-org.ts
 *
 * Behavior on errors:
 *   - Missing/undecryptable token → row left in place, reported as `reauth`.
 *   - GitHub 5xx / network → row left in place, reported as `errored`.
 *   - GitHub 401 → row left in place, reported as `reauth`. (Production
 *     would also revoke that user's credentials; this script does not, to
 *     stay read/delete-only on the user_repos surface.)
 */

import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { repos, userRepos, users } from "../src/db/schema";
import { decryptGithubToken } from "../src/auth/tokens";
import { config } from "../src/config";
import { githubHeaders, parseNextUrl } from "../src/user/github-helpers";

interface Row {
  userId: number;
  userLogin: string;
  tokenCiphertext: string | null;
  repoId: number;
  fullName: string;
  owner: string;
  name: string;
}

interface Outcome {
  kept: number;
  revoked: number;
  reauthNeeded: number;
  errored: number;
}

const DRY_RUN = process.argv.includes("--dry-run");
const PAGE_CAP = 5;

type OrgsLookup = { ok: true; orgs: Set<string> } | { ok: false; reason: "reauth" | "error" };

const orgsCache = new Map<number, Promise<OrgsLookup>>();

async function loadOrgs(userId: number, ciphertext: string | null): Promise<OrgsLookup> {
  const hit = orgsCache.get(userId);
  if (hit) return hit;
  const promise = (async (): Promise<OrgsLookup> => {
    if (!ciphertext) return { ok: false, reason: "reauth" };
    let token: string;
    try {
      token = await decryptGithubToken(ciphertext, config.encryptionKey);
    } catch {
      return { ok: false, reason: "reauth" };
    }
    const orgs = new Set<string>();
    let url: string | null =
      "https://api.github.com/user/memberships/orgs?state=active&per_page=100";
    let pages = 0;
    while (url && pages < PAGE_CAP) {
      pages += 1;
      let res: Response;
      try {
        res = await fetch(url, { headers: githubHeaders(token) });
      } catch {
        return { ok: false, reason: "error" };
      }
      if (res.status === 401) return { ok: false, reason: "reauth" };
      if (!res.ok) return { ok: false, reason: "error" };
      const body = (await res.json().catch(() => null)) as Array<{
        state?: string;
        organization?: { login?: string };
      }> | null;
      if (!Array.isArray(body)) return { ok: false, reason: "error" };
      for (const m of body) {
        if (m.state !== "active") continue;
        const login = m.organization?.login;
        if (typeof login === "string" && login.length > 0) orgs.add(login.toLowerCase());
      }
      url = parseNextUrl(res.headers.get("link"));
    }
    return { ok: true, orgs };
  })();
  orgsCache.set(userId, promise);
  return promise;
}

type CheckResult = "keep" | "revoke" | "reauth" | "error";

async function checkOne(row: Row): Promise<CheckResult> {
  if (row.owner.toLowerCase() === row.userLogin.toLowerCase()) return "keep";
  const lookup = await loadOrgs(row.userId, row.tokenCiphertext);
  if (!lookup.ok) return lookup.reason;
  return lookup.orgs.has(row.owner.toLowerCase()) ? "keep" : "revoke";
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      userId: userRepos.userId,
      userLogin: users.githubLogin,
      tokenCiphertext: users.githubToken,
      repoId: userRepos.repoId,
      fullName: repos.fullName,
      owner: repos.owner,
      name: repos.name,
    })
    .from(userRepos)
    .innerJoin(users, eq(users.id, userRepos.userId))
    .innerJoin(repos, eq(repos.id, userRepos.repoId));

  console.log(
    `[reclassify] ${rows.length} (userId, repoId) pairs to check${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  const outcome: Outcome = { kept: 0, revoked: 0, reauthNeeded: 0, errored: 0 };
  const revokeList: Array<{ userId: number; repoId: number; fullName: string; userLogin: string }> =
    [];
  const reauthList: Array<{ userLogin: string; fullName: string }> = [];

  for (const row of rows) {
    const k = await checkOne(row);
    if (k === "keep") outcome.kept += 1;
    else if (k === "revoke") {
      outcome.revoked += 1;
      revokeList.push({
        userId: row.userId,
        repoId: row.repoId,
        fullName: row.fullName,
        userLogin: row.userLogin,
      });
    } else if (k === "reauth") {
      outcome.reauthNeeded += 1;
      reauthList.push({ userLogin: row.userLogin, fullName: row.fullName });
    } else {
      outcome.errored += 1;
    }
  }

  if (revokeList.length > 0) {
    console.log(`[reclassify] ${revokeList.length} rows to revoke:`);
    const byUser = new Map<string, string[]>();
    for (const r of revokeList) {
      const list = byUser.get(r.userLogin) ?? [];
      list.push(r.fullName);
      byUser.set(r.userLogin, list);
    }
    for (const [login, names] of byUser) {
      console.log(`    user=${login} repos=${names.join(", ")}`);
    }
  }
  if (reauthList.length > 0) {
    console.log(`[reclassify] ${reauthList.length} rows pending reauth (left in place):`);
    const byUser = new Map<string, number>();
    for (const r of reauthList) byUser.set(r.userLogin, (byUser.get(r.userLogin) ?? 0) + 1);
    for (const [login, n] of byUser) {
      console.log(`    user=${login} rows=${n}`);
    }
  }

  if (!DRY_RUN && revokeList.length > 0) {
    for (const r of revokeList) {
      await db
        .delete(userRepos)
        .where(and(eq(userRepos.userId, r.userId), eq(userRepos.repoId, r.repoId)));
    }
    console.log(`[reclassify] deleted ${revokeList.length} user_repos rows`);
  }

  console.log(
    `[reclassify] done: kept=${outcome.kept} revoked=${outcome.revoked} reauthNeeded=${outcome.reauthNeeded} errored=${outcome.errored}`,
  );
}

await main();
