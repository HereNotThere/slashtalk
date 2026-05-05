DELETE FROM "api_keys"
WHERE "id" NOT IN (
  SELECT DISTINCT ON ("device_id") "id"
  FROM "api_keys"
  ORDER BY "device_id", "created_at" DESC NULLS LAST, "id" DESC
);

CREATE UNIQUE INDEX "api_keys_device_unique" ON "api_keys" USING btree ("device_id");
