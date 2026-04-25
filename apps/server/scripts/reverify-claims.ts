#!/usr/bin/env bun
/**
 * Re-verifies every `user_repos` row against GitHub using the owning user's
 * stored OAuth token. Rows where the token no longer has access are deleted
 * (closing the pre-gate leak window). Rows whose token is missing or stale
 * are left in place and reported, so the user can fix them on next sign-in.
 *
 * Run ONCE manually against prod after deploying the claim-gate in
 * apps/server/src/user/routes.ts, before any client starts relying on the
 * stricter authorization. Not wired into the regular deploy pipeline.
 *
 *   cd apps/server && bun run scripts/reverify-claims.ts
 *     # or with --dry-run to log without mutating:
 *   bun run scripts/reverify-claims.ts --dry-run
 */

import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { repos, userRepos, users } from "../src/db/schema";
import { decryptGithubToken } from "../src/auth/tokens";
import { config } from "../src/config";
import { githubHeaders } from "../src/user/routes";

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
const BATCH_SIZE = 10;
// Be kind to GitHub; 5000 req/hr per token is fine for us, but this prevents
// a bad parallel batch from stampeding.
const BATCH_SLEEP_MS = 100;

// Decrypt each user's token once per run instead of per row. A user with
// 50 claims would otherwise run WebCrypto 50 times.
const tokenCache = new Map<number, Promise<string | null>>();

function decryptOnce(
  userId: number,
  ciphertext: string | null,
): Promise<string | null> {
  const hit = tokenCache.get(userId);
  if (hit) return hit;
  const promise = ciphertext
    ? decryptGithubToken(ciphertext, config.encryptionKey).catch(
        () => null as string | null,
      )
    : Promise.resolve<string | null>(null);
  tokenCache.set(userId, promise);
  return promise;
}

type CheckResult = "keep" | "revoke" | "reauth" | "error";

async function checkOne(row: Row): Promise<CheckResult> {
  const token = await decryptOnce(row.userId, row.tokenCiphertext);
  if (!token) return "reauth";
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.name)}`,
      { headers: githubHeaders(token) },
    );
  } catch {
    return "error";
  }
  if (res.status === 200) return "keep";
  if (res.status === 404) return "revoke";
  if (res.status === 401 || res.status === 403) return "reauth";
  return "error";
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
    `[reverify] ${rows.length} (userId, repoId) pairs to check${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  const outcome: Outcome = { kept: 0, revoked: 0, reauthNeeded: 0, errored: 0 };
  const revokeList: Array<{ userId: number; repoId: number; fullName: string; userLogin: string }> = [];
  const reauthList: Array<{ userLogin: string; fullName: string }> = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((r) => checkOne(r)));
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const k = results[j];
      if (k === "keep") outcome.kept += 1;
      else if (k === "revoke") {
        outcome.revoked += 1;
        revokeList.push({
          userId: r.userId,
          repoId: r.repoId,
          fullName: r.fullName,
          userLogin: r.userLogin,
        });
      } else if (k === "reauth") {
        outcome.reauthNeeded += 1;
        reauthList.push({ userLogin: r.userLogin, fullName: r.fullName });
      } else {
        outcome.errored += 1;
      }
    }
    if (i + BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
    }
  }

  if (revokeList.length > 0) {
    console.log(`[reverify] ${revokeList.length} rows to revoke:`);
    for (const r of revokeList) {
      console.log(`    user=${r.userLogin} repo=${r.fullName}`);
    }
  }
  if (reauthList.length > 0) {
    console.log(
      `[reverify] ${reauthList.length} rows pending reauth (left in place):`,
    );
    // Compact: group by user, list distinct repo count.
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
        .where(
          and(
            eq(userRepos.userId, r.userId),
            eq(userRepos.repoId, r.repoId),
          ),
        );
    }
    console.log(`[reverify] deleted ${revokeList.length} user_repos rows`);
  }

  console.log(
    `[reverify] done: kept=${outcome.kept} revoked=${outcome.revoked} reauthNeeded=${outcome.reauthNeeded} errored=${outcome.errored}`,
  );
}

await main();
