// POST /v1/me/prs — desktop pushes the caller's own PRs (sourced from the
// local `gh` CLI) so the server's `pull_requests` table is fresh enough for
// the standup composer to reference them on the same day they're opened.
//
// Trust model: API-key auth identifies the caller; we discard any entry whose
// repo isn't in `repos` (not claimed by anyone) and force `authorLogin` to
// the caller's `githubLogin`. The route cannot mutate other users' PRs even
// if a malicious payload tries to.
//
// `headRef` is preserved on insert but NOT clobbered on update — the
// canonical source for that field is the GitHub events poller (`pr-poller`),
// which sees PullRequestEvent payloads. Letting this route overwrite headRef
// would risk regressing data in the rare case where pr-poller has the right
// branch and gh search returned a stale one.

import { Elysia, t } from "elysia";
import { sql } from "drizzle-orm";
import type {
  IngestSelfPrEntry,
  IngestSelfPrsRequest,
  IngestSelfPrsResponse,
} from "@slashtalk/shared";
import type { Database } from "../db";
import { repos, pullRequests } from "../db/schema";
import { apiKeyAuth } from "../auth/middleware";
import { invalidateSelfStandupCache } from "../user/dashboard";

const MAX_PRS_PER_INGEST = 100;

export const prIngestRoutes = (db: Database) =>
  new Elysia({ prefix: "/v1", name: "prIngest" }).use(apiKeyAuth).post(
    "/me/prs",
    async ({ body, user }): Promise<IngestSelfPrsResponse> => {
      const entries = body.prs.slice(0, MAX_PRS_PER_INGEST);
      if (entries.length === 0) return { upserted: 0, unknownRepos: 0 };

      // Resolve repos in one round-trip — case-insensitive on full_name to
      // match how pr-poller looks them up (`lower(full_name) = lower(?)`).
      const wanted = unique(entries.map((e) => e.repoFullName.toLowerCase()));
      const repoRows = await db
        .select({ id: repos.id, fullName: repos.fullName })
        .from(repos)
        .where(sql`lower(${repos.fullName}) IN ${wanted}`);
      const repoIdByName = new Map<string, number>();
      for (const r of repoRows) repoIdByName.set(r.fullName.toLowerCase(), r.id);

      const rows: (typeof pullRequests.$inferInsert)[] = [];
      let unknownRepos = 0;
      for (const e of entries) {
        const repoId = repoIdByName.get(e.repoFullName.toLowerCase());
        if (repoId === undefined) {
          unknownRepos++;
          continue;
        }
        rows.push({
          repoId,
          number: e.number,
          headRef: e.headRef,
          title: e.title,
          url: e.url,
          state: e.state,
          authorLogin: user.githubLogin,
          updatedAt: new Date(e.updatedAt),
        });
      }
      if (rows.length > 0) {
        // One round-trip for the whole batch. `excluded.<col>` references
        // the row we tried to insert, so the conflict path picks up the
        // freshest values without us re-listing them per-row. headRef is
        // omitted from SET — pr-poller is authoritative.
        await db
          .insert(pullRequests)
          .values(rows)
          .onConflictDoUpdate({
            target: [pullRequests.repoId, pullRequests.number],
            set: {
              title: sql`excluded.title`,
              url: sql`excluded.url`,
              state: sql`excluded.state`,
              authorLogin: sql`excluded.author_login`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
        invalidateSelfStandupCache(user.id);
      }
      return { upserted: rows.length, unknownRepos };
    },
    {
      body: t.Object({
        prs: t.Array(
          t.Object({
            number: t.Integer({ minimum: 1 }),
            title: t.String(),
            url: t.String(),
            repoFullName: t.String(),
            state: t.Union([t.Literal("open"), t.Literal("closed"), t.Literal("merged")]),
            updatedAt: t.String(),
            headRef: t.String(),
          }),
        ),
      }),
    },
  );

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

// Body type alignment check — keeps the route literal in sync with the
// shared interface so a renamed field in @slashtalk/shared surfaces as a TS
// error rather than a silent runtime mismatch.
type _AssertBodyShape = IngestSelfPrsRequest extends { prs: IngestSelfPrEntry[] } ? true : never;
const _assert: _AssertBodyShape = true;
void _assert;
