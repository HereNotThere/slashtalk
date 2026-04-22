-- Dedupe (user_id, device_name) before the unique index. Canonical = MAX(id).
-- Re-parent children of duplicate devices, then drop the duplicates.
CREATE TEMP TABLE _dup_devices ON COMMIT DROP AS
SELECT d.id AS dup_id, c.canonical_id
FROM devices d
JOIN (
  SELECT user_id, device_name, MAX(id) AS canonical_id
  FROM devices
  GROUP BY user_id, device_name
) c ON c.user_id = d.user_id AND c.device_name = d.device_name
WHERE d.id <> c.canonical_id;

UPDATE sessions s
SET device_id = d.canonical_id
FROM _dup_devices d
WHERE s.device_id = d.dup_id;

UPDATE heartbeats h
SET device_id = d.canonical_id
FROM _dup_devices d
WHERE h.device_id = d.dup_id;

INSERT INTO device_repo_paths (device_id, repo_id, local_path)
SELECT d.canonical_id, drp.repo_id, drp.local_path
FROM device_repo_paths drp
JOIN _dup_devices d ON drp.device_id = d.dup_id
ON CONFLICT (device_id, repo_id) DO NOTHING;

INSERT INTO device_excluded_repos (device_id, repo_id)
SELECT d.canonical_id, der.repo_id
FROM device_excluded_repos der
JOIN _dup_devices d ON der.device_id = d.dup_id
ON CONFLICT (device_id, repo_id) DO NOTHING;

DELETE FROM devices
WHERE id IN (SELECT dup_id FROM _dup_devices);

CREATE UNIQUE INDEX "devices_user_name_unique" ON "devices" USING btree ("user_id","device_name");
