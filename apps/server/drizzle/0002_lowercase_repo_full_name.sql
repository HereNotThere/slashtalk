-- Canonicalize repos.full_name (and owner/name) to lowercase so that two
-- users who cloned the same GitHub repo under different casings in their
-- remote URLs (e.g. AcmeCorp/Slashtalk vs acmecorp/slashtalk) converge on a
-- single repos row and can see each other in /api/feed.
--
-- GitHub treats owner/name as case-insensitive; our unique index on
-- repos.full_name was case-sensitive, silently splitting the social graph.
-- This migration merges any case-duplicate rows onto the earliest id, then
-- lowercases the surviving rows. Application code (POST /api/me/repos) now
-- normalizes on write, so this only needs to run once.

-- Build the merge map: every repo id → the canonical id for its lowered name.
CREATE TEMP TABLE repo_merge ON COMMIT DROP AS
SELECT
  id AS old_id,
  MIN(id) OVER (PARTITION BY LOWER(full_name)) AS new_id
FROM repos;
--> statement-breakpoint

-- user_repos: drop rows that would collide with the canonical (user_id, new_id)
-- PK before rewriting the rest.
DELETE FROM user_repos ur
USING repo_merge m
WHERE ur.repo_id = m.old_id
  AND m.old_id <> m.new_id
  AND EXISTS (
    SELECT 1 FROM user_repos ur2
    WHERE ur2.user_id = ur.user_id AND ur2.repo_id = m.new_id
  );
--> statement-breakpoint

UPDATE user_repos ur
SET repo_id = m.new_id
FROM repo_merge m
WHERE ur.repo_id = m.old_id AND m.old_id <> m.new_id;
--> statement-breakpoint

-- device_repo_paths: same composite-PK handling.
DELETE FROM device_repo_paths drp
USING repo_merge m
WHERE drp.repo_id = m.old_id
  AND m.old_id <> m.new_id
  AND EXISTS (
    SELECT 1 FROM device_repo_paths drp2
    WHERE drp2.device_id = drp.device_id AND drp2.repo_id = m.new_id
  );
--> statement-breakpoint

UPDATE device_repo_paths drp
SET repo_id = m.new_id
FROM repo_merge m
WHERE drp.repo_id = m.old_id AND m.old_id <> m.new_id;
--> statement-breakpoint

-- device_excluded_repos: same.
DELETE FROM device_excluded_repos der
USING repo_merge m
WHERE der.repo_id = m.old_id
  AND m.old_id <> m.new_id
  AND EXISTS (
    SELECT 1 FROM device_excluded_repos der2
    WHERE der2.device_id = der.device_id AND der2.repo_id = m.new_id
  );
--> statement-breakpoint

UPDATE device_excluded_repos der
SET repo_id = m.new_id
FROM repo_merge m
WHERE der.repo_id = m.old_id AND m.old_id <> m.new_id;
--> statement-breakpoint

-- sessions: simple FK, no composite PK to worry about.
UPDATE sessions s
SET repo_id = m.new_id
FROM repo_merge m
WHERE s.repo_id = m.old_id AND m.old_id <> m.new_id;
--> statement-breakpoint

-- Remove the now-orphaned duplicate repo rows.
DELETE FROM repos r
USING repo_merge m
WHERE r.id = m.old_id AND m.old_id <> m.new_id;
--> statement-breakpoint

-- Lowercase the survivors. The unique index on full_name now stays satisfied
-- because the merge step above guaranteed one row per LOWER(full_name).
UPDATE repos SET
  full_name = LOWER(full_name),
  owner = LOWER(owner),
  name = LOWER(name);
