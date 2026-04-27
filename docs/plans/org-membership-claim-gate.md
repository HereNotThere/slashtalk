---
task: org-membership-claim-gate
status: approved
created: 2026-04-27
approved_by: user
approved_at: 2026-04-27
---

# Plan: Org-membership claim gate

## Goal

Replace per-repo access verification with org-membership verification as the only repo-claim gate, and remove the GitHub App from the codebase entirely.

## Requirements

- `POST /api/me/repos` accepts a claim when `owner` appears in the caller's active org memberships from `GET /user/memberships/orgs?state=active`.
- Same endpoint accepts a claim when `owner === user.githubLogin` (personal namespace), with no GitHub call required for that branch.
- Same endpoint rejects every other claim with `403 no_access` and the existing `{ error, message }` body shape.
- Existing 30/hour per-user rate limit and 60-second claim-verify cache are preserved (still useful against enumeration).
- The 5 `users.github_app_*` columns are **retained as-is** in `apps/server/src/db/schema.ts` so the App can be re-introduced in the future without a data migration. No new Drizzle migration is generated.
- All 4 GitHub-App env vars (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`) are removed from `apps/server/src/config.ts` and from the `Environment` section of `docs/SECURITY.md`.
- `apps/server/src/auth/github-app.ts` is deleted; the `githubAppAuth` plugin is unmounted from the app composition root.
- `GET /api/me/github-app/status` is deleted.
- Desktop: `getGithubAppStatus`, `connectGithubApp`, the `useGithubAppStatus` hook, the connect-button blocks in tray and main window, the IPC preload methods, and the `GithubAppStatus` shared type are deleted.
- The error-message branch in the desktop renderer that special-cases "Slashtalk GitHub App" is removed; remaining `no_access` copy is updated to mention OAuth-app org restrictions instead.
- `apps/server/test/user-repo-claim.test.ts` is rewritten: 6 App-flow cases dropped; new cases cover org-member success, non-member rejection, personal-namespace success, stale token, GitHub 5xx, cache hit, and rate limit.
- `apps/server/scripts/reclassify-by-org.ts` exists, supports `--dry-run`, walks `user_repos`, and deletes rows that don't pass the new gate. Replaces `apps/server/scripts/reverify-claims.ts`.
- `docs/SECURITY.md` "Repo-claim verification" section is rewritten; "OAuth scope" section drops the App reference; `docs/design-docs/core-beliefs.md` §§ 11–12 are rewritten; `CLAUDE.md` memory aids #11–#12 match the new model.
- `docs/solutions/security-issues/github-app-oauth-identity-binding-2026-04-25.md` gets a one-line "Superseded" header but stays in place as historical record.
- `bun run typecheck && bun run test` passes from `apps/server/`. `bun run typecheck` passes from `apps/desktop/`.

## Constraints

- OAuth scope stays `read:user read:org`. No expansion to `repo`.
- `user_repos` schema and the existing `permission` column shape are unchanged (single tier, semantically still `claimed`). No new column or tier introduced.
- The 14 cross-user authorization read sites (`social/routes.ts`, `sessions/access.ts`, `chat/tools.ts`, `chat/cards.ts`, `chat/runner.ts`, `ws/handler.ts`, `presence/routes.ts`, `social/github-sync.ts`, `user/claim.ts:280`, `user/routes.ts:197`) are NOT modified — single permission tier means filter logic is unchanged.
- Strict-tracking gate in the desktop uploader (core-belief #6) is untouched.
- Drizzle schema and migrations are untouched. The App columns persist as orphan storage; existing rows retain their (encrypted) values until a future cleanup decides their fate.
- Desktop `claimRepo` IPC and `ClaimRepoError` shape are preserved; only the `kind: "github_app_required"` value goes away from the union.
- Redis publishing soft-fail invariant (core-belief #7) is untouched.
- All Elysia plugin `name` values remain globally unique (core-belief #3); plugins removed are removed wholesale, never renamed.

## Approach

`POST /api/me/repos { fullName: "owner/name" }` accepts a claim if `owner` is in the user's active orgs (`GET /user/memberships/orgs?state=active`) **or** `owner === user.githubLogin`. Otherwise `403 no_access`. Single permission tier (`claimed`, unchanged). No schema changes, no cross-user filter audit, no UI work. Delete all GitHub App code paths: the `auth/github-app.ts` plugin, the `/api/me/github-app/status` route, the 4 App env vars, the desktop "Connect GitHub App" UI in both the tray (`statusbar/App.tsx`) and main window (`SlashtalkSection.tsx`), the IPC bridge methods, the `GithubAppStatus` shared type, and the 6 App-flow tests. The 5 `users.github_app_*` schema columns are **retained** so the App can be re-introduced later without a data migration. A one-shot `scripts/reclassify-by-org.ts` walks existing `user_repos` rows and deletes any that don't pass the new gate. Update `SECURITY.md`, `core-beliefs.md` §§ 11–12, and `CLAUDE.md` memory aids.

## Alternatives considered

- **Expand OAuth to `repo` scope** — rejected: blast radius, "Full control of private repositories" consent screen.
- **Keep App as outside-collaborator escape hatch** — rejected per CEO direction.
- **Folder-only trust** — rejected: re-opens PR #85 leak.
- **Org-or-self-or-any-public-repo** — rejected per "keep simple": would re-introduce cross-user joining on popular public repos and force a `self_only` permission tier plus 14-site filter audit.

## Main risk

Two compounding losses vs. today:

1. **Intra-org claims are unconstrained.** Any org member can claim any repo in their org and inherit cross-user visibility, regardless of GitHub's per-repo ACL. Same trust posture as Slack/Linear; must land precisely in `SECURITY.md` so customers using GitHub repo-level ACLs as an information barrier (M&A, legal, compliance) self-select out.
2. **Existing public-OSS-repo claims will be deleted at migration time** (`torvalds/linux`, `vercel/next.js`, etc.). Migration script must surface deletions clearly so we can communicate to affected users.

## Affected files

**Server:**

- `apps/server/src/user/claim.ts` — replace `verifyRepoAccess` with the org-or-self check; delete `verifyRepoAccessWithGitHubAppUserToken`, `findRepoInGitHubAppInstallation`, `githubAppUserHeaders`; remove App-related imports; refactor `outcome.kind` union to drop `github_app_required` / `github_grant_revoked`.
- `apps/server/src/user/github-helpers.ts` — add `fetchUserOrgMemberships(db, userId): Promise<string[]>` that returns active org logins (lowercased), with the same 60s TTL caching pattern used elsewhere.
- `apps/server/src/auth/github-app.ts` — DELETE.
- `apps/server/src/user/routes.ts` — delete `GET /api/me/github-app/status` and the imports of `githubAppConnectionStatus`, `githubAppConnectUrl`, `githubAppConnectUrlForUser`, `githubAppInstallUrl`.
- `apps/server/src/db/schema.ts` — **unchanged**. The 5 `github_app_*` columns stay so the App can be re-introduced later without a data migration.
- `apps/server/src/config.ts` — delete `githubAppClientId`, `githubAppClientSecret`, `githubAppId`, `githubAppSlug` and their env-var loaders.
- `apps/server/src/app.ts` (or composition root) — unmount `githubAppAuth(...)` plugin.
- `apps/server/test/user-repo-claim.test.ts` — drop 6 App-flow tests; replace `repos/` mock + App-installations mocks with `/user/memberships/orgs` mock; add the new gate's test cases.
- `apps/server/scripts/reverify-claims.ts` — DELETE.
- `apps/server/scripts/reclassify-by-org.ts` — NEW one-shot script. Walks `user_repos`; for each row decrypts the user's OAuth token, fetches their orgs once, decides keep/delete; supports `--dry-run`. Logs deleted rows by `(userLogin, fullName)` so we can communicate.

**Desktop:**

- `apps/desktop/src/main/backend.ts` — delete `getGithubAppStatus`, `connectGithubApp`. Update `ClaimRepoError`'s `kind` union to remove `github_app_required` and `isClaimRepoErrorKind` to match.
- `apps/desktop/src/main/preload.ts` (or wherever `window.chatheads.backend` is composed) — delete the two App IPC bridge methods.
- `apps/desktop/src/renderer/statusbar/App.tsx` — delete `useGithubAppStatus`, `githubAppRefreshKey`/`githubAppWatch` state, the connect-block render path, the `isGithubApp` error-message branch.
- `apps/desktop/src/renderer/main/SlashtalkSection.tsx` — delete its `githubApp` state, `refreshGithubApp` callback, watch effect, and connect-block render.
- `apps/desktop/src/shared/types.ts` — delete `GithubAppStatus`.

**Docs:**

- `docs/SECURITY.md` — rewrite "Repo-claim verification"; update "OAuth scope" to drop App references; remove App env vars from "Environment".
- `docs/design-docs/core-beliefs.md` — rewrite § 11 (no more App carve-out; identity is OAuth, repo claims gate on org membership or personal namespace) and § 12 (verification mechanism changed; same load-bearing role).
- `CLAUDE.md` — update load-bearing memories #11 and #12; the inline `POST /api/me/repos` description must reflect the new gate.
- `docs/solutions/security-issues/github-app-oauth-identity-binding-2026-04-25.md` — prepend `> **Superseded** by `docs/plans/org-membership-claim-gate.md` (2026-04-27). Kept as historical record of the previous identity-binding bug.`

## Implementation steps

1. **Server: rewrite the gate in `claim.ts`.** Add `fetchUserOrgMemberships` helper in `github-helpers.ts` (with 60s TTL cache, same shape as `orgsCache` in `user/orgs.ts`). Replace `verifyRepoAccess` with `verifyOrgOrSelf(user, fullName)` that returns `{ ok: true } | { ok: false, kind: "no_access" | "token_expired" | "upstream_unavailable" }`. Delete the three App-fallback functions. Update the route handler's outcome branching to drop `github_app_required` and `github_grant_revoked` (the latter still triggers `revokeAllUserCredentials` on a 401 from the orgs endpoint — same behavior, different trigger).
2. **Server: unmount and delete the App plugin.** Remove `githubAppAuth` from the composition root. Delete `apps/server/src/auth/github-app.ts`. Remove App imports from `user/routes.ts` and delete `GET /api/me/github-app/status`. Run `bun run typecheck` to confirm no dangling imports. Note: `users.github_app_*` columns stay in the schema (per amendment 1) — Drizzle will keep emitting them; nothing in code reads or writes them after this step.
3. **Server: drop App env vars from `config.ts`.** Remove the four fields and their `process.env.*` reads. Confirm `bun run typecheck` is still green.
4. **Server: rewrite `user-repo-claim.test.ts`.** Strip the App-related fetch mocks (`/user/installations`, `/user/installations/:id/repositories`, refresh-token endpoint, `storeGitHubAppToken` helper). Add a `/user/memberships/orgs` mock that returns a configurable org list. Drop 6 App-flow tests. Add: org-member claim succeeds; non-member 403 `no_access`; personal-namespace claim succeeds without GitHub call; stale token (`401` from orgs) revokes credentials and returns `401 token_expired`; GitHub 5xx returns `502 upstream_unavailable`; cached membership avoids second GitHub call; rate limit at 30/hr returns `429`. Run `bun run typecheck && bun run test` from `apps/server/` until green.
5. **Server: write `scripts/reclassify-by-org.ts`.** Same shape as `reverify-claims.ts`: open DB, walk `user_repos` joined with `users` and `repos`, for each user decrypt token once, fetch `/user/memberships/orgs`, decide keep (`owner` ∈ orgs ∨ `owner === userLogin`) or delete. Log delete list grouped by `userLogin`. Support `--dry-run`. Smoke against local DB. Delete `scripts/reverify-claims.ts` in the same commit.
6. **Desktop: remove backend functions and IPC.** From `apps/desktop/src/main/backend.ts`, delete `getGithubAppStatus`, `connectGithubApp`, and the `github_app_required` value from `ClaimRepoError`'s union and `isClaimRepoErrorKind`. From the IPC preload, delete the two methods exposed to the renderer.
7. **Desktop: remove App UI from tray.** In `apps/desktop/src/renderer/statusbar/App.tsx`, delete `useGithubAppStatus` hook + its return-state plumbing, the watch state and timer, the connect-block JSX, and the `isGithubApp` error-message branch (line ~444). Remaining `no_access` message becomes: "GitHub doesn't show this repo in your orgs. If your org restricts OAuth apps, an admin may need to approve slashtalk."
8. **Desktop: remove App UI from main window.** In `apps/desktop/src/renderer/main/SlashtalkSection.tsx`, delete the `githubApp` state, `refreshGithubApp`, the watch effect, the connect-block JSX, and the `githubApp` prop from any child components that consume it.
9. **Desktop: delete `GithubAppStatus`** from `apps/desktop/src/shared/types.ts`. Run `bun run typecheck` from `apps/desktop/` until green.
10. **Docs: rewrite `SECURITY.md`.** Replace "Repo-claim verification" section with the new gate's behavior (org match → accept; personal namespace → accept; else `403 no_access`). Update "OAuth scope" to drop the App carve-out and to describe the new claim flow. Remove the four App env vars from "Environment".
11. **Docs: rewrite `core-beliefs.md` §§ 11–12.** § 11 becomes: "Identity is user OAuth; repo claims gate on org membership or personal namespace." § 12 becomes: "Repo claims are verified against `/user/memberships/orgs` or matched to the caller's own login. Never accept on assertion alone." Update `CLAUDE.md` memory aids #11–#12 to match.
12. **Docs: append Superseded header** to `docs/solutions/security-issues/github-app-oauth-identity-binding-2026-04-25.md`.
13. **Final validation.** `bun run typecheck && bun run test` from `apps/server/`. `bun run typecheck` from `apps/desktop/`. `grep -rn "github-app\|githubApp\|github_app" apps/server/src apps/desktop/src` returns matches **only** in `apps/server/src/db/schema.ts` (the retained columns) — no other source file should reference the App.

## User-facing surfaces

This plan removes UI; no new UI added.

- **Copy changes (only deletions and one rewrite):**
  - Tray + main-window connect block: removed wholesale. No replacement copy.
  - `+ Add local repo` error toast on `403 no_access`: today shows "GitHub doesn't show you have access to this repo" or, if App fallback was tried, a longer App-install hint. After: a single message — "GitHub doesn't show this repo in your orgs. If your org restricts OAuth apps, an admin may need to approve slashtalk."
  - The `connectUrl` field in the `403 no_access` response body is dropped from server responses; renderer no longer reads it.
- **Wordmark / branding:** unchanged.
- **Success state:** identical to today — the new repo appears in the user's tracked-repo list and rail.
- **Error states:** the `kind` union shrinks to `no_access | token_expired | upstream_unavailable | rate_limited | invalid_full_name | unknown`. No new error states.
- **Empty state:** unchanged. A user signed in with no orgs and no claimed repos sees the same empty rail; the only difference is they no longer see a "Connect GitHub App" prompt suggesting that as a path.
- **Loading state:** unchanged.

## Edge cases

- **OAuth-app org restrictions** → if user's org has third-party-OAuth restrictions and slashtalk is unapproved, the org won't appear in `/user/memberships/orgs`. Claim → 403 `no_access`. Mitigation: the new error message explicitly hints at this case so an org admin knows to act.
- **User belongs to no orgs** → `/user/memberships/orgs` returns `[]`. Personal-namespace claims still work. Org claims fail. Acceptable.
- **GitHub 5xx during membership fetch** → fail closed with `502 upstream_unavailable`, mirroring the current claim path's 5xx handling.
- **GitHub 401 during membership fetch** → token is revoked. Run `revokeAllUserCredentials` (existing helper) and respond `401 token_expired`. Same recovery flow as today.
- **GitHub 403 during membership fetch** → treated as `upstream_unavailable` (rate-limit / abuse case); does not invalidate credentials.
- **Pending org memberships** → `state=active` filter excludes them. A user with only a pending invite cannot claim that org's repos until they accept on GitHub. Acceptable.
- **Membership cache staleness** → 60s TTL means a user just removed from an org could still claim during that window. Not a security concern under the new trust model (org membership is the boundary; freshness within 60s is fine).
- **Pre-existing `user_repos` rows that fail the new gate** → `reclassify-by-org.ts` deletes them. Affected users see the rows disappear on next refresh. No in-product warning; we accept this since the deleted claims are by definition the public-OSS-and-cross-org case the CEO has chosen to drop.
- **Concurrent claims during migration** → migration runs offline, manually invoked. If we're cautious, run during low-traffic. Race window is irrelevant because new claims under the new gate produce only valid rows.
- **`users.github_app_*` columns referenced from other code paths** → there should be none after step 2; the columns stay in the schema as orphan storage. Step 3's `bun run typecheck` will catch any code-side straggler. The columns themselves persist with their existing (encrypted) values until a future cleanup decides their fate.
- **Personal-namespace impostor** → `bob` cannot claim `alice/repo` because `owner === user.githubLogin` requires the caller's login. The login on the JWT comes from the trusted `users.githubLogin` column at OAuth-callback time, not from the request body, so there is no spoofing surface.

## Acceptance criteria

- [ ] `apps/server/`: `bun run typecheck && bun run test` green.
- [ ] `apps/desktop/`: `bun run typecheck` green.
- [ ] `grep -rn "github-app\|githubApp\|github_app" apps/server/src` returns matches **only** in `apps/server/src/db/schema.ts` (the retained columns).
- [ ] `grep -rn "githubApp\|GithubApp\|github_app" apps/desktop/src` returns no matches.
- [ ] `POST /api/me/repos` test cases all pass: org-member success, non-member 403 `no_access`, personal-namespace success, stale token 401, GitHub 5xx 502, cache hit avoids second call, 31st claim/hour returns 429.
- [ ] `apps/server/scripts/reclassify-by-org.ts --dry-run` runs against a local DB and prints a `kept=N revoked=M` summary; without `--dry-run`, actually deletes the M rows.
- [ ] `apps/server/scripts/reverify-claims.ts` no longer exists.
- [ ] `docs/SECURITY.md` "Repo-claim verification" describes the new gate and contains no GitHub App references.
- [ ] `docs/design-docs/core-beliefs.md` §§ 11–12 reflect the new model; `CLAUDE.md` memory aids #11–#12 match.
- [ ] PR description summarizes the trust-model shift in one paragraph (intra-org leakage explicit).

## Out of scope

- **Re-verification on login / cron / webhook.** Deferred per direction; documented as a known limitation in `SECURITY.md`.
- **Members-list UI.** Dropped per "no UX scope expansion."
- **`self_only` permission tier and 14-site cross-user filter audit.** Not needed when the third bucket (public OSS by non-members) is dropped.
- **Outside-collaborator escape hatch.** Out per CEO direction; contractor-with-no-org-seat case is explicitly denied.
- **Public OSS repo claims by non-members.** Out: any repo whose `owner` isn't in the caller's orgs and isn't their own login is denied.
- **Migration of `docs/solutions/security-issues/github-app-oauth-identity-binding-2026-04-25.md` content.** Out: doc gets a Superseded header, body stays as historical record.
- **Sentry / observability for org-fetch failures.** Out: existing logging in `githubFetch` is sufficient for now.
- **Communicating to users whose claims were deleted.** Out of code scope; the migration script's grouped delete log is the input to a separate comms task.
- **Dropping the 5 `users.github_app_*` columns.** Retained for future re-introduction option; deferred to a later cleanup if/when we commit to the new model permanently.

## Plan amendments

- **2026-04-27 — Amendment 1: retain `users.github_app_*` schema columns.** User direction: "keep the database schemas for now, we might add it in the future." Removed the schema edit (former step 3) and the `docs/generated/db-schema.md` regeneration (former step 14) from Implementation steps. Renumbered steps 4–15 → 3–13. Updated Requirements, Constraints, Approach, Affected files, Edge cases, Acceptance criteria, and Out of scope to reflect that the 5 `users.github_app_user_token`, `github_app_refresh_token`, `github_app_token_expires_at`, `github_app_refresh_token_expires_at`, `github_app_connected_at` columns persist as orphan storage. Code in `auth/github-app.ts` is still deleted; the columns stay so a future re-introduction doesn't need a data migration.

- **2026-04-27 — Amendment 2: drop GitHub-canonical repo metadata for new claims.** Surfaced during step 1 execution. The new gate doesn't call `GET /repos/:owner/:name`, so it has no canonical `id`, `private`, or canonical-cased `name` to populate `repos.github_id` / `repos.private` / `repos.name` on insert. Decision: insert with user-input `owner`/`name`, lowercased `fullName` via `normalizeFullName`, `private = false` (column default), and `githubId = null` (column already nullable per schema.ts:177 comment). Downstream impact is bounded: `repos.githubId` has zero consumers; `repos.private` is read only in the `GET /api/me/repos` response body for cosmetic display. Existing rows retain their values (the `onConflictDoUpdate` set-clause stops overwriting them with the now-unknown values; on re-claim, we leave existing metadata as-is and don't update). Affects step 1 only; no new steps.

## Three questions

1. **What was the hardest decision?** Whether to retain a `self_only` permission tier so public-OSS claims (`vercel/next.js` for non-Vercel users) could continue. Two real options: keep it (preserve the use case at the cost of a 14-site cross-user filter audit and a new permission column semantically), or drop it (smaller diff, fewer code-path changes, but lose that use case). Picked the simpler version per the user's "keep things simple" direction. Cost: existing users tracking OSS contributions to repos they don't own will see those claims deleted at migration time.

2. **What alternatives were rejected, and why?** OAuth `repo` scope expansion (full read/write blast radius if our DB leaks; consent-screen wording kills conversion; contradicts core-belief #11). App-as-fallback for outside collaborators (CEO direction is to remove the App entirely). Folder-only trust (re-introduces the PR #85 leak). Org-or-self-or-public-OAuth (would force `self_only` tier and the cross-user filter audit back in scope).

3. **What are you least confident about?** Two things, in priority order:
   - **Migration blast radius on real data.** We don't know how many existing `user_repos` rows are public-OSS claims that will be deleted. `reclassify-by-org.ts --dry-run` against prod is the only way to find out, and the answer might force a soft-launch comms plan we haven't allocated time for. If the count is high and unexpected, we may want to land the gate change without running the migration immediately, leaving stale rows to be cleaned up separately.
   - **OAuth-app-restricted orgs.** Users in orgs with third-party-OAuth restrictions where slashtalk isn't approved will see their org silently absent from `/user/memberships/orgs`. The new gate denies them. We can't detect this server-side (the org just doesn't appear); the error-message hint is the only mitigation. Some customers will hit this and not understand why — and the support burden is unknown.
