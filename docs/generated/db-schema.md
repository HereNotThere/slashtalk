# Database schema

> Auto-generated from [`apps/server/src/db/schema.ts`](../../apps/server/src/db/schema.ts). Do not edit by hand. Regenerate with `bun run gen:db-schema` from `apps/server/`.

Tables: `agent_sessions`, `api_keys`, `device_excluded_repos`, `device_repo_paths`, `devices`, `events`, `heartbeats`, `oauth_authorization_codes`, `oauth_clients`, `oauth_tokens`, `refresh_tokens`, `repos`, `session_insights`, `sessions`, `setup_tokens`, `user_repos`, `users`

## `agent_sessions`

Drizzle export: `agentSessions`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `user_login` | `PgText` | not null |
| `agent_id` | `PgText` | not null |
| `session_id` | `PgText` | not null |
| `mode` | `PgText` | not null |
| `visibility` | `PgText` | not null, has default |
| `name` | `PgText` | — |
| `started_at` | `PgTimestamp` | not null |
| `ended_at` | `PgTimestamp` | — |
| `last_activity` | `PgTimestamp` | not null, has default |
| `summary` | `PgText` | — |
| `summary_model` | `PgText` | — |
| `summary_ts` | `PgTimestamp` | — |

**Indexes:**
- `agent_sessions_session_id_key` (unique index) on `(session_id)`
- `agent_sessions_user_started_idx` (index) on `(user_login, started_at)`
- `agent_sessions_agent_started_idx` (index) on `(agent_id, started_at)`

## `api_keys`

Drizzle export: `apiKeys`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `user_id` | `PgInteger` | not null |
| `device_id` | `PgInteger` | not null |
| `key_hash` | `PgText` | not null |
| `last_used_at` | `PgTimestamp` | — |
| `created_at` | `PgTimestamp` | has default |

## `device_excluded_repos`

Drizzle export: `deviceExcludedRepos`.

| Column | Type | Notes |
| --- | --- | --- |
| `device_id` | `PgInteger` | not null |
| `repo_id` | `PgInteger` | not null |

**Primary key:** `(device_id, repo_id)`

## `device_repo_paths`

Drizzle export: `deviceRepoPaths`.

| Column | Type | Notes |
| --- | --- | --- |
| `device_id` | `PgInteger` | not null |
| `repo_id` | `PgInteger` | not null |
| `local_path` | `PgText` | not null |

**Primary key:** `(device_id, repo_id)`

## `devices`

Drizzle export: `devices`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `user_id` | `PgInteger` | not null |
| `device_name` | `PgText` | not null |
| `os` | `PgText` | — |
| `created_at` | `PgTimestamp` | has default |
| `last_seen_at` | `PgTimestamp` | — |

**Indexes:**
- `devices_user_name_unique` (unique index) on `(user_id, device_name)`

## `events`

Drizzle export: `events`.

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | `PgUUID` | not null |
| `line_seq` | `PgBigInt53` | not null |
| `user_id` | `PgInteger` | not null |
| `project` | `PgText` | not null |
| `source` | `PgText` | not null |
| `ts` | `PgTimestamp` | not null |
| `raw_type` | `PgText` | not null |
| `kind` | `PgText` | not null |
| `turn_id` | `PgText` | — |
| `call_id` | `PgText` | — |
| `event_id` | `PgText` | — |
| `parent_id` | `PgText` | — |
| `payload` | `PgJsonb` | not null |
| `ingested_at` | `PgTimestamp` | has default |

**Primary key:** `(session_id, line_seq)`

**Indexes:**
- `events_session_ts_idx` (index) on `(session_id, ts)`
- `events_user_project_ts_idx` (index) on `(user_id, project, ts)`
- `events_call_idx` (index) on `(session_id, call_id)`
- `events_turn_idx` (index) on `(session_id, turn_id)`
- `events_event_id_idx` (unique index) on `(event_id)`

## `heartbeats`

Drizzle export: `heartbeats`.

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | `PgUUID` | pk, not null |
| `user_id` | `PgInteger` | not null |
| `device_id` | `PgInteger` | — |
| `pid` | `PgInteger` | — |
| `kind` | `PgText` | — |
| `updated_at` | `PgTimestamp` | — |

## `oauth_authorization_codes`

Drizzle export: `oauthAuthorizationCodes`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `code_hash` | `PgText` | not null |
| `user_id` | `PgInteger` | not null |
| `client_id` | `PgText` | not null |
| `redirect_uri` | `PgText` | not null |
| `code_challenge` | `PgText` | not null |
| `scope` | `PgText` | not null |
| `resource` | `PgText` | not null |
| `expires_at` | `PgTimestamp` | not null |
| `used_at` | `PgTimestamp` | — |
| `created_at` | `PgTimestamp` | has default |

**Indexes:**
- `oauth_authorization_codes_code_hash_key` (unique index) on `(code_hash)`
- `oauth_authorization_codes_user_id_idx` (index) on `(user_id)`
- `oauth_authorization_codes_client_id_idx` (index) on `(client_id)`

## `oauth_clients`

Drizzle export: `oauthClients`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `client_id` | `PgText` | not null |
| `client_kind` | `PgText` | not null |
| `client_name` | `PgText` | not null |
| `redirect_uris` | `PgJsonb` | not null |
| `grant_types` | `PgJsonb` | not null |
| `response_types` | `PgJsonb` | not null |
| `token_endpoint_auth_method` | `PgText` | not null |
| `scope` | `PgText` | not null |
| `created_at` | `PgTimestamp` | has default |
| `updated_at` | `PgTimestamp` | has default |

**Indexes:**
- `oauth_clients_client_id_key` (unique index) on `(client_id)`
- `oauth_clients_kind_idx` (index) on `(client_kind)`

## `oauth_tokens`

Drizzle export: `oauthTokens`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `user_id` | `PgInteger` | not null |
| `client_id` | `PgText` | not null |
| `access_token_hash` | `PgText` | not null |
| `refresh_token_hash` | `PgText` | not null |
| `scope` | `PgText` | not null |
| `resource` | `PgText` | not null |
| `access_expires_at` | `PgTimestamp` | not null |
| `refresh_expires_at` | `PgTimestamp` | not null |
| `revoked_at` | `PgTimestamp` | — |
| `created_at` | `PgTimestamp` | has default |

**Indexes:**
- `oauth_tokens_access_token_hash_key` (unique index) on `(access_token_hash)`
- `oauth_tokens_refresh_token_hash_key` (unique index) on `(refresh_token_hash)`
- `oauth_tokens_user_id_idx` (index) on `(user_id)`
- `oauth_tokens_client_id_idx` (index) on `(client_id)`

## `refresh_tokens`

Drizzle export: `refreshTokens`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `user_id` | `PgInteger` | not null |
| `token_hash` | `PgText` | not null |
| `expires_at` | `PgTimestamp` | not null |
| `created_at` | `PgTimestamp` | has default |

## `repos`

Drizzle export: `repos`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `github_id` | `PgBigInt53` | — |
| `full_name` | `PgText` | not null |
| `owner` | `PgText` | not null |
| `name` | `PgText` | not null |
| `private` | `PgBoolean` | has default |
| `created_at` | `PgTimestamp` | has default |

## `session_insights`

Drizzle export: `sessionInsights`.

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | `PgUUID` | not null |
| `analyzer_name` | `PgText` | not null |
| `analyzer_version` | `PgText` | not null |
| `output` | `PgJsonb` | not null |
| `input_line_seq` | `PgBigInt53` | not null, has default |
| `model` | `PgText` | not null |
| `tokens_in` | `PgInteger` | has default |
| `tokens_out` | `PgInteger` | has default |
| `tokens_cache_read` | `PgInteger` | has default |
| `cost_usd` | `PgNumeric` | has default |
| `analyzed_at` | `PgTimestamp` | has default |
| `error_text` | `PgText` | — |

**Primary key:** `(session_id, analyzer_name)`

**Indexes:**
- `session_insights_analyzed_at_idx` (index) on `(analyzed_at)`

## `sessions`

Drizzle export: `sessions`.

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | `PgUUID` | pk, not null |
| `user_id` | `PgInteger` | not null |
| `device_id` | `PgInteger` | — |
| `source` | `PgText` | not null |
| `provider` | `PgText` | — |
| `project` | `PgText` | not null |
| `repo_id` | `PgInteger` | — |
| `title` | `PgText` | — |
| `first_ts` | `PgTimestamp` | — |
| `last_ts` | `PgTimestamp` | — |
| `user_msgs` | `PgInteger` | has default |
| `assistant_msgs` | `PgInteger` | has default |
| `tool_calls` | `PgInteger` | has default |
| `tool_errors` | `PgInteger` | has default |
| `events` | `PgInteger` | has default |
| `tokens_in` | `PgBigInt53` | has default |
| `tokens_out` | `PgBigInt53` | has default |
| `tokens_cache_read` | `PgBigInt53` | has default |
| `tokens_cache_write` | `PgBigInt53` | has default |
| `tokens_reasoning` | `PgBigInt53` | has default |
| `model` | `PgText` | — |
| `version` | `PgText` | — |
| `branch` | `PgText` | — |
| `cwd` | `PgText` | — |
| `in_turn` | `PgBoolean` | has default |
| `current_turn_id` | `PgText` | — |
| `last_boundary_ts` | `PgTimestamp` | — |
| `outstanding_tools` | `PgJsonb` | has default |
| `last_user_prompt` | `PgText` | — |
| `top_files_read` | `PgJsonb` | has default |
| `top_files_edited` | `PgJsonb` | has default |
| `top_files_written` | `PgJsonb` | has default |
| `tool_use_names` | `PgJsonb` | has default |
| `queued` | `PgJsonb` | has default |
| `recent_events` | `PgJsonb` | has default |
| `server_line_seq` | `PgBigInt53` | has default |
| `prefix_hash` | `PgText` | — |

**Indexes:**
- `sessions_user_last_ts_idx` (index) on `(user_id, last_ts)`
- `sessions_repo_last_ts_idx` (index) on `(repo_id, last_ts)`

## `setup_tokens`

Drizzle export: `setupTokens`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `user_id` | `PgInteger` | not null |
| `token` | `PgText` | not null |
| `expires_at` | `PgTimestamp` | not null |
| `redeemed` | `PgBoolean` | has default |
| `created_at` | `PgTimestamp` | has default |

## `user_repos`

Drizzle export: `userRepos`.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | `PgInteger` | not null |
| `repo_id` | `PgInteger` | not null |
| `permission` | `PgText` | not null |
| `synced_at` | `PgTimestamp` | has default |

**Primary key:** `(user_id, repo_id)`

**Indexes:**
- `user_repos_repo_id_idx` (index) on `(repo_id)`

## `users`

Drizzle export: `users`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `PgSerial` | pk, not null, has default |
| `github_id` | `PgBigInt53` | not null |
| `github_login` | `PgText` | not null |
| `avatar_url` | `PgText` | — |
| `display_name` | `PgText` | — |
| `github_token` | `PgText` | not null |
| `created_at` | `PgTimestamp` | has default |
| `updated_at` | `PgTimestamp` | has default |

