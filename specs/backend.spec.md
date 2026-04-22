# slashtalk — Backend Service Spec

## Overview

Slashtalk is a hosted backend that aggregates Claude Code session data
from users' machines, organizes it around GitHub repository membership,
and provides a real-time social feed of coding sessions. Users sign in
with GitHub, install a CLI watcher on their machines, and see sessions
from everyone who shares repo access with them.

## Tech Stack

| Layer          | Choice                                      |
|----------------|---------------------------------------------|
| Runtime        | Bun                                         |
| Framework      | ElysiaJS                                     |
| API docs       | `@elysiajs/openapi` (auto-generated)         |
| ORM            | Drizzle ORM + `drizzle-typebox`              |
| Database       | Managed PostgreSQL (Render)                  |
| Pub/Sub        | Managed Redis / Valkey (Render Key Value)    |
| Auth           | GitHub OAuth2 (`read:org`, `repo` scopes)    |
| Deployment     | Render.com web service (native Bun runtime)  |

---

## 1. Authentication

### 1.1 GitHub OAuth Flow (Web)

1. User clicks "Sign in with GitHub" → redirect to GitHub authorize URL.
2. GitHub redirects back with `code`.
3. Server exchanges `code` for a GitHub access token.
4. Server fetches `GET /user` from GitHub API → extract `id`, `login`,
   `avatar_url`, `name`.
5. Upsert user in `users` table. Store the GitHub access token
   (encrypted at rest) for later API calls (repo listing, org membership).
6. Issue a signed JWT session token (short-lived, 1h) + refresh token
   (long-lived, 30d) stored in `refresh_tokens` table.
7. Set `httpOnly` cookie with the session JWT for web requests.

**Required GitHub OAuth scopes:** `read:user`, `read:org`, `repo`

- `repo` gives visibility into private repos the user can push to.
- `read:org` lets us enumerate org membership for social graph.

### 1.2 CLI Token Exchange (Install Script)

1. User clicks "Generate Install Token" in web UI.
2. Server creates a row in `setup_tokens` table:
   `{token: crypto.randomUUID(), user_id, expires_at: now + 10min, redeemed: false}`.
3. UI shows: `curl <baseurl>/install.sh | sh -s <token>`.
4. The install script (see §6) calls `POST /v1/auth/exchange` with the
   setup token.
5. Server validates the token (not expired, not redeemed), marks it
   redeemed, creates a row in `devices` table, and returns a long-lived
   API key (stored in `api_keys` table, hashed with SHA-256).
6. The CLI stores the API key in `~/.claude/slashtalk.json`.

### 1.3 WebSocket Auth

Token passed as query parameter on the upgrade request:

```
wss://slashtalk.example.com/ws?token=<jwt_or_api_key>
```

The `beforeHandle` middleware validates the token before the HTTP→WS
upgrade completes. Invalid tokens get a 401 before upgrade.

---

## 2. Data Model (Drizzle / Postgres)

### 2.1 Users & Auth

```sql
create table users (
  id              serial primary key,
  github_id       bigint unique not null,
  github_login    text not null,
  avatar_url      text,
  display_name    text,
  github_token    text not null,          -- encrypted GitHub access token
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table refresh_tokens (
  id              serial primary key,
  user_id         int references users(id) on delete cascade,
  token_hash      text unique not null,   -- SHA-256 of the refresh token
  expires_at      timestamptz not null,
  created_at      timestamptz default now()
);

create table setup_tokens (
  id              serial primary key,
  user_id         int references users(id) on delete cascade,
  token           text unique not null,
  expires_at      timestamptz not null,
  redeemed        boolean default false,
  created_at      timestamptz default now()
);

create table devices (
  id              serial primary key,
  user_id         int references users(id) on delete cascade,
  device_name     text not null,          -- hostname or user-provided label
  os              text,                   -- darwin, linux, etc.
  created_at      timestamptz default now(),
  last_seen_at    timestamptz
);

create table api_keys (
  id              serial primary key,
  user_id         int references users(id) on delete cascade,
  device_id       int references devices(id) on delete cascade,
  key_hash        text unique not null,   -- SHA-256 of the API key
  last_used_at    timestamptz,
  created_at      timestamptz default now()
);
```

### 2.2 Repos & Social Graph

```sql
create table repos (
  id              serial primary key,
  github_id       bigint unique not null,
  full_name       text not null,          -- e.g. "org/repo-name"
  owner           text not null,
  name            text not null,
  private         boolean default false,
  created_at      timestamptz default now()
);

create table user_repos (
  user_id         int references users(id) on delete cascade,
  repo_id         int references repos(id) on delete cascade,
  permission      text not null,          -- push, admin, maintain
  synced_at       timestamptz default now(),
  primary key (user_id, repo_id)
);
create index on user_repos (repo_id);
```

### 2.3 Session & Event Storage

Follows the schema from `upload.spec.md` with additions for
multi-device tracking:

```sql
create table sessions (
  session_id      uuid primary key,
  user_id         int references users(id) on delete cascade,
  device_id       int references devices(id),
  project         text not null,          -- slugified cwd
  repo_id         int references repos(id), -- matched repo, nullable
  -- derived aggregates (updated on ingest)
  title           text,
  first_ts        timestamptz,
  last_ts         timestamptz,
  user_msgs       int default 0,
  assistant_msgs  int default 0,
  tool_calls      int default 0,
  tool_errors     int default 0,
  events          int default 0,
  tokens_in       bigint default 0,
  tokens_cw5      bigint default 0,
  tokens_cw1      bigint default 0,
  tokens_cr       bigint default 0,
  tokens_out      bigint default 0,
  cost_usd        numeric(12,4) default 0,
  model           text,
  version         text,
  branch          text,
  cwd             text,
  in_turn         bool default false,
  last_boundary_ts timestamptz,
  outstanding_tools jsonb default '{}',
  last_user_prompt text,
  top_files_read   jsonb default '[]',
  top_files_edited jsonb default '[]',
  top_files_written jsonb default '[]',
  tool_use_names   jsonb default '{}',
  queued           jsonb default '[]',
  recent_events    jsonb default '[]',
  server_offset    bigint default 0,
  prefix_hash      text
);
create index on sessions (user_id, last_ts desc);
create index on sessions (repo_id, last_ts desc);

create table events (
  uuid            uuid primary key,
  user_id         int not null,
  session_id      uuid not null references sessions(session_id),
  project         text not null,
  ts              timestamptz not null,
  type            text not null,
  parent_uuid     uuid,
  byte_offset     bigint,
  payload         jsonb not null,
  ingested_at     timestamptz default now()
);
create index on events (session_id, ts);

create table heartbeats (
  session_id      uuid primary key references sessions(session_id),
  user_id         int not null,
  device_id       int,
  pid             int,
  kind            text,
  updated_at      timestamptz
);
```

### 2.4 Repo ↔ Session Matching

When a session is ingested, the server attempts to match the session's
`cwd` (working directory) to a known repo by:

1. Extracting the git remote URL from the session events (if available
   in the payload), OR
2. Matching the `project` slug against known repo paths from the
   device's repo list (sent during install setup — see §6).

The `repo_id` on the session is what connects it to the social graph.
Sessions without a matched repo are visible only to their owner.

---

## 3. Redis Pub/Sub

### 3.1 Channel Design

Every GitHub repo is a Redis pub/sub channel:

```
channel: repo:<repo_id>
```

When a session is updated (new events ingested, heartbeat received),
the server publishes a lightweight notification to the repo's channel:

```json
{
  "type": "session_updated",
  "session_id": "<uuid>",
  "user_id": 42,
  "github_login": "alice",
  "repo_id": 7,
  "last_ts": "2026-04-22T10:44:01.782Z",
  "state": "busy"
}
```

### 3.2 Subscription Management

When a WebSocket connection is established:

1. Look up all `repo_id`s the user belongs to (from `user_repos`).
2. Subscribe the Redis client to `repo:<id>` for each repo.
3. Forward any messages received on those channels to the WebSocket.

When the user refreshes their social graph (§4), update subscriptions:
unsubscribe from removed repos, subscribe to added ones.

### 3.3 Additional Channels

```
channel: user:<user_id>          -- personal notifications (device online/offline, etc.)
```

---

## 4. Social Graph

### 4.1 Repo Sync

Triggered manually by the user via a "Refresh repos" button in settings.

1. Call GitHub API: `GET /user/repos?per_page=100&type=all` (paginate).
2. Filter to repos where the user has `push` permission or higher
   (`permissions.push == true`).
3. Upsert into `repos` table, update `user_repos` join table.
4. Delete `user_repos` rows for repos the user no longer has access to.
5. Record `synced_at` timestamp.
6. Also runs automatically on first login.

### 4.2 Social Graph Query

"Who is in my social graph?" = all users who share at least one repo
with me:

```sql
select distinct ur2.user_id
from user_repos ur1
join user_repos ur2 on ur1.repo_id = ur2.repo_id
where ur1.user_id = :me and ur2.user_id != :me;
```

"What sessions can I see?" = all sessions whose `repo_id` is in my
repo set:

```sql
select s.*
from sessions s
join user_repos ur on s.repo_id = ur.repo_id
where ur.user_id = :me
order by
  case s.state
    when 'busy' then 0
    when 'active' then 1
    when 'idle' then 2
    when 'recent' then 3
    else 4
  end,
  s.last_ts desc;
```

### 4.3 Privacy Model

- Sessions matched to a repo are visible to all users with push access
  to that repo.
- Sessions with no matched repo are visible only to their owner.
- During CLI install, users can deselect repos per-device. Deselected
  repos are stored in `device_excluded_repos` and their sessions are
  not uploaded.

```sql
create table device_excluded_repos (
  device_id       int references devices(id) on delete cascade,
  repo_id         int references repos(id) on delete cascade,
  primary key (device_id, repo_id)
);
```

---

## 5. API Endpoints

All endpoints auto-documented via `@elysiajs/openapi` at `/openapi`.
JSON request/response bodies validated with TypeBox schemas that double
as OpenAPI definitions via `drizzle-typebox`.

### 5.1 Auth

| Method | Path                      | Auth   | Description                              |
|--------|---------------------------|--------|------------------------------------------|
| GET    | `/auth/github`            | none   | Redirect to GitHub OAuth authorize URL   |
| GET    | `/auth/github/callback`   | none   | Handle OAuth callback, issue JWT + refresh |
| POST   | `/auth/refresh`           | cookie | Exchange refresh token for new JWT       |
| POST   | `/auth/logout`            | cookie | Revoke refresh token                     |
| POST   | `/v1/auth/exchange`       | none   | Exchange setup token for API key         |

### 5.2 User & Settings

| Method | Path                      | Auth   | Description                              |
|--------|---------------------------|--------|------------------------------------------|
| GET    | `/api/me`                 | jwt    | Current user profile                     |
| GET    | `/api/me/devices`         | jwt    | List user's devices                      |
| DELETE | `/api/me/devices/:id`     | jwt    | Remove a device + its API key            |
| POST   | `/api/me/sync-repos`      | jwt    | Trigger GitHub repo sync                 |
| GET    | `/api/me/repos`           | jwt    | List user's repos (with excluded status) |
| POST   | `/api/me/setup-token`     | jwt    | Generate a new setup token               |

### 5.3 Ingest (CLI → Server)

| Method | Path                      | Auth    | Description                             |
|--------|---------------------------|---------|-----------------------------------------|
| POST   | `/v1/ingest`              | api_key | Upload JSONL event chunk                |
| GET    | `/v1/sync-state`          | api_key | Get server-side sync state for resume   |
| POST   | `/v1/heartbeat`           | api_key | Session heartbeat (every ~5s)           |

**`POST /v1/ingest`** — as defined in `upload.spec.md`:

- Headers: `Authorization: Bearer <api_key>`
- Query: `project`, `session`, `fromOffset`, `prefixHash`
- Body: `application/x-ndjson`
- The server derives `device_id` from the authenticated API key
  (`api_keys.device_id`); no separate device header is sent or accepted.
- On successful ingest of new events, publish `session_updated` to the
  session's repo channel in Redis.

**`POST /v1/heartbeat`**:

- Body: `{sessionId, pid, kind, cwd, version, startedAt}`
- Updates `heartbeats` table.
- If heartbeat changes session state (e.g. idle→busy), publish update.

### 5.4 Dashboard (Social Feed)

| Method | Path                        | Auth | Description                                  |
|--------|-----------------------------|------|----------------------------------------------|
| GET    | `/api/feed`                 | jwt  | Sessions from user's social graph            |
| GET    | `/api/feed/users`           | jwt  | Users in social graph with session counts     |
| GET    | `/api/sessions`             | jwt  | User's own sessions (compat with upload spec) |
| GET    | `/api/session/:id`          | jwt  | Full session snapshot                        |
| GET    | `/api/session/:id/events`   | jwt  | Paginated event list for a session           |

**`GET /api/feed`**

Query params: `?tab=all|by-user|by-repo`, `?user=<login>`,
`?repo=<full_name>`, `?state=busy|active|idle|recent|ended`

Response: array of session snapshots (same shape as `upload.spec.md`
snapshot schema), augmented with:

```json
{
  "...snapshot fields...",
  "github_login": "alice",
  "avatar_url": "https://...",
  "repo_full_name": "org/repo"
}
```

**`GET /api/feed/users`**

Response:

```json
[
  {
    "github_login": "alice",
    "avatar_url": "https://...",
    "total_sessions": 47,
    "active_sessions": 2,
    "repos": ["org/repo-a", "org/repo-b"]
  }
]
```

`active_sessions` = sessions with `last_ts` within the last 15 minutes.

**`GET /api/session/:id/events`**

Query params: `?cursor=<uuid>&limit=50`

Response: paginated list of raw events (from `events` table), ordered
by `ts`. Used for the session detail view to browse individual events.

### 5.5 Install Script

| Method | Path            | Auth | Description                         |
|--------|-----------------|------|-------------------------------------|
| GET    | `/install.sh`   | none | Serve the install shell script      |

The script is a static shell script served with `Content-Type: text/plain`.
The setup token is passed as an argument by the user, not baked into the
script URL.

### 5.6 WebSocket

| Path  | Auth        | Description                    |
|-------|-------------|--------------------------------|
| `/ws` | query token | Real-time session update feed  |

**Protocol:**

Server → Client messages only (client does not send messages after
connect). Messages are JSON:

```json
{
  "type": "session_updated",
  "session_id": "<uuid>",
  "github_login": "alice",
  "repo_full_name": "org/repo",
  "state": "busy",
  "last_ts": "2026-04-22T10:44:01.782Z"
}
```

The client uses this as a signal to re-fetch specific data via REST if
it needs the full snapshot (approach A from clarifying questions).

Server sends a ping frame every 30s to keep the connection alive
(required for Render's load balancer).

---

## 6. Install Script (`install.sh`)

The script is a POSIX-compatible shell script that:

### 6.1 Token Exchange

1. Accept setup token as `$1`.
2. Prompt for a device name (default: `$(hostname)`).
3. `POST /v1/auth/exchange` with `{token, device_name, os}`.
4. Receive API key. Write config to `~/.claude/slashtalk.json`:

```json
{
  "api_key": "<key>",
  "device_id": 3,
  "server": "https://slashtalk.example.com",
  "excluded_repos": [],
  "watched_repos": []
}
```

### 6.2 Repo Discovery

1. Search for git repos starting from `$HOME`, **2 levels deep**:
   `find ~ -maxdepth 2 -name .git -type d`.
2. If zero repos found, prompt the user for a path and search there.
3. After initial search, prompt: "Any additional directories to scan?
   (enter path or press Enter to skip)".
4. For each discovered repo, extract `git remote get-url origin` to
   identify the GitHub repo.
5. Display a numbered list of discovered repos with checkboxes
   (all selected by default). User can deselect by number.
6. Send the selected/deselected list to
   `POST /v1/devices/:id/repos` so the server records
   `device_excluded_repos`.

### 6.3 Initial Upload

1. For each selected repo, find matching `.claude/projects/<slug>/`
   directories by converting the repo path to the Claude slug format
   (replace `/` with `-`).
2. Upload all `*.jsonl` files via `POST /v1/ingest` in chunks.
3. Show progress.

### 6.4 Watch Mode

1. After initial upload, enter watch mode.
2. Use `fswatch` (macOS) or `inotifywait` (Linux) to watch
   `~/.claude/projects/` for changes to `*.jsonl` files.
3. On change, read new bytes from the tracked offset and upload via
   `POST /v1/ingest`.
4. Maintain sync state in `~/.claude/slashtalk-sync.json` (same format
   as `upload.spec.md` sync-state).
5. Run heartbeats: check `~/.claude/sessions/*.json` every 5s, send
   `POST /v1/heartbeat` for live sessions.

The watcher runs as a background process. The install script offers to
set up a launchd plist (macOS) or systemd user service (Linux) for
persistence.

---

## 7. Frontend Pages

The web frontend is server-rendered HTML or a lightweight SPA served by
ElysiaJS. Minimal styling, functional.

### 7.1 Homepage / Feed (`/`)

Requires login. Shows sessions from the user's social graph.

**Layout:**

- **Header:** User avatar, logout, settings link.
- **Filter bar:** Tabs for "All", "By User", "By Repo". State filter
  buttons: All / Live / Busy / Active / Recent.
- **User cards** (when "By User" tab): Each card shows:
  - GitHub avatar + username
  - Total sessions count
  - Active sessions count (updated in last 15 min) — highlighted
  - Click to filter feed to that user
- **Session list:** Table/cards showing sessions matching current
  filters. Columns: User, Repo, Title, State, Model, Branch, Duration,
  Cost, Last Activity.
- **Real-time:** WebSocket connection updates session cards in-place
  when `session_updated` messages arrive (re-fetch the updated session
  via REST).

### 7.2 Session Detail (`/session/:id`)

- **Header:** Session title, user, repo, branch, model, state badge.
- **Stats bar:** Duration, messages, tool calls, tokens, cost.
- **Event list:** Chronological list of events. Each event shows:
  - Timestamp
  - Type badge (user / assistant / tool_use / tool_result)
  - Summary text (first line of user message, tool name + description
    for tool calls, truncated assistant response)
  - Expandable to show full content
- Paginated, loads more on scroll.

### 7.3 Settings (`/settings`)

- **Devices:** List of registered devices with last-seen time. Delete
  button.
- **Repos:** List of repos with sync status. "Refresh from GitHub"
  button.
- **Install:** Generate new setup token, shows the curl command.

### 7.4 Login (`/login`)

Single "Sign in with GitHub" button.

---

## 8. Deployment (Render.com)

### 8.1 Services

| Service            | Type           | Notes                                  |
|--------------------|----------------|----------------------------------------|
| `slashtalk-web`    | Web Service    | Bun runtime, port 10000               |
| `slashtalk-db`     | PostgreSQL     | Managed, starter plan                  |
| `slashtalk-redis`  | Key Value      | Managed Valkey, for pub/sub            |

### 8.2 Environment Variables

```
DATABASE_URL=<internal postgres URL>
REDIS_URL=<internal redis URL>
GITHUB_CLIENT_ID=<oauth app client id>
GITHUB_CLIENT_SECRET=<oauth app client secret>
JWT_SECRET=<random 256-bit secret>
ENCRYPTION_KEY=<for encrypting GitHub tokens at rest>
BASE_URL=https://slashtalk.onrender.com
PORT=10000
```

### 8.3 Build & Start

```
Build command:  bun install && bun run db:migrate
Start command:  bun run src/index.ts
```

### 8.4 WebSocket Considerations (Render)

- Must use `wss://` — Render redirects `ws://` with 301.
- Connections are not sticky across deploys; clients must reconnect
  with exponential backoff.
- Server sends ping frames every 30s to prevent idle disconnects.
- Single instance initially; if scaling horizontally, Redis pub/sub
  ensures all instances see all messages.

---

## 9. Project Structure

```
slashtalk/
├── bun.lock
├── bunfig.toml
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── specs/
│   ├── backend.spec.md          # this file
│   └── upload.spec.md           # ingest protocol spec
├── src/
│   ├── index.ts                 # Elysia app entry, plugin composition
│   ├── config.ts                # env var loading + validation
│   ├── db/
│   │   ├── schema.ts            # Drizzle table definitions
│   │   ├── migrate.ts           # Migration runner
│   │   └── migrations/          # Generated SQL migrations
│   ├── auth/
│   │   ├── github.ts            # OAuth flow handlers
│   │   ├── middleware.ts         # JWT + API key validation
│   │   └── tokens.ts            # Token generation, hashing, exchange
│   ├── ingest/
│   │   ├── routes.ts            # /v1/ingest, /v1/sync-state, /v1/heartbeat
│   │   ├── parser.ts            # JSONL event parsing
│   │   └── aggregator.ts        # Session aggregate computation
│   ├── social/
│   │   ├── routes.ts            # /api/feed, /api/feed/users
│   │   ├── graph.ts             # Social graph queries
│   │   └── github-sync.ts       # Repo sync from GitHub API
│   ├── sessions/
│   │   ├── routes.ts            # /api/sessions, /api/session/:id
│   │   ├── snapshot.ts          # Session state classification
│   │   └── state.ts             # Busy/active/idle/recent/ended logic
│   ├── ws/
│   │   ├── handler.ts           # WebSocket connection handler
│   │   └── redis-bridge.ts      # Redis sub → WebSocket forwarding
│   ├── install/
│   │   └── install.sh           # Static install script
│   └── frontend/
│       ├── pages/               # HTML templates or SPA
│       └── static/              # CSS, JS assets
├── scripts/
│   └── db-seed.ts               # Dev seed data
└── Dockerfile                   # Optional, for Docker-based deploy
```

---

## 10. Session State Machine

Session state is **computed at read time**, not stored. The classification
uses the same logic as the local `server.py`:

```
                 heartbeat fresh?
                 ┌──yes──────────────────────┐
                 │                           │
                 │   in_turn?                │
                 │   ├─ yes → BUSY           │
                 │   └─ no                   │
                 │       last event < 10s?   │
                 │       ├─ yes → ACTIVE     │
                 │       └─ no  → IDLE       │
                 │                           │
                 └──no───────────────────────┘
                         last event < 1h?
                         ├─ yes → RECENT
                         └─ no  → ENDED
```

"Heartbeat fresh" = `heartbeats.updated_at` is within the last 30s.

The `state` field in session snapshots is computed by a function in
`src/sessions/state.ts`, not persisted in the database. This avoids
stale state and matches the reference implementation.

---

## 11. Ingest → Pub/Sub Flow

```
CLI watcher
  │
  ├── POST /v1/ingest (JSONL chunk)
  │     ├── parse events
  │     ├── upsert events (dedup by uuid)
  │     ├── update session aggregates
  │     ├── match repo_id (if not yet matched)
  │     └── PUBLISH repo:<repo_id> session_updated
  │           │
  │           └── Redis ──→ all WS connections subscribed to repo:<repo_id>
  │                           │
  │                           └── { type: "session_updated", session_id, ... }
  │                                 │
  │                                 └── Browser re-fetches GET /api/session/:id
  │
  └── POST /v1/heartbeat
        ├── upsert heartbeat row
        └── if state changed → PUBLISH repo:<repo_id> session_updated
```

---

## 12. Non-Goals (for v1)

- **Codex session support** — Claude only for now.
- **Automatic repo sync** — manual button only; no background cron.
- **Session search / full-text search** — just list and filter.
- **Session sharing links** — no public/unauthenticated access.
- **Multi-region** — single Render region.
- **Horizontal scaling** — single instance; Redis pub/sub is ready for
  multi-instance but not required yet.
- **Email notifications** — WebSocket only.
