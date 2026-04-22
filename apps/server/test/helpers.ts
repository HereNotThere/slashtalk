import { sql } from "drizzle-orm";
import { db } from "../src/db";

// ── Mock GitHub OAuth ────────────────────────────────────────

interface MockUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string;
}

const MOCK_USERS: Record<string, MockUser> = {
  alice_code: {
    id: 1001,
    login: "alice",
    avatar_url: "https://avatars.test/alice",
    name: "Alice",
  },
  bob_code: {
    id: 1002,
    login: "bob",
    avatar_url: "https://avatars.test/bob",
    name: "Bob",
  },
};

let originalFetch: typeof globalThis.fetch;

export function mockGitHubAuth(): () => void {
  originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Mock GitHub OAuth token exchange
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(init?.body as string);
      if (MOCK_USERS[body.code]) {
        return new Response(
          JSON.stringify({ access_token: `ghtoken_${body.code}` }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ error: "bad_verification_code" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Mock GitHub user API
    if (url === "https://api.github.com/user") {
      const headers = init?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization || headers?.authorization || "";
      const match = auth.match(/Bearer ghtoken_(.+)/);
      if (match && MOCK_USERS[match[1]]) {
        return new Response(JSON.stringify(MOCK_USERS[match[1]]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    // Pass through everything else (local server requests, etc.)
    return originalFetch(input, init);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ── Database Schema ──────────────────────────────────────────

export async function resetDatabase() {
  await db.execute(sql`SET client_min_messages = WARNING`);
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);

  await db.execute(sql`
    CREATE TABLE users (
      id              SERIAL PRIMARY KEY,
      github_id       BIGINT UNIQUE NOT NULL,
      github_login    TEXT NOT NULL,
      avatar_url      TEXT,
      display_name    TEXT,
      github_token    TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE devices (
      id              SERIAL PRIMARY KEY,
      user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name     TEXT NOT NULL,
      os              TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX devices_user_name_unique
      ON devices (user_id, device_name)
  `);

  await db.execute(sql`
    CREATE TABLE refresh_tokens (
      id              SERIAL PRIMARY KEY,
      user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash      TEXT UNIQUE NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE api_keys (
      id              SERIAL PRIMARY KEY,
      user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id       INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      key_hash        TEXT UNIQUE NOT NULL,
      last_used_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE setup_tokens (
      id              SERIAL PRIMARY KEY,
      user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token           TEXT UNIQUE NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL,
      redeemed        BOOLEAN DEFAULT FALSE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE repos (
      id              SERIAL PRIMARY KEY,
      github_id       BIGINT UNIQUE NOT NULL,
      full_name       TEXT NOT NULL,
      owner           TEXT NOT NULL,
      name            TEXT NOT NULL,
      private         BOOLEAN DEFAULT FALSE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE user_repos (
      user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repo_id         INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      permission      TEXT NOT NULL,
      synced_at       TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, repo_id)
    )
  `);
  await db.execute(sql`CREATE INDEX ON user_repos (repo_id)`);

  await db.execute(sql`
    CREATE TABLE device_excluded_repos (
      device_id       INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      repo_id         INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      PRIMARY KEY (device_id, repo_id)
    )
  `);

  await db.execute(sql`
    CREATE TABLE device_repo_paths (
      device_id       INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      repo_id         INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      local_path      TEXT NOT NULL,
      PRIMARY KEY (device_id, repo_id)
    )
  `);

  await db.execute(sql`
    CREATE TABLE sessions (
      session_id      UUID PRIMARY KEY,
      user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id       INT REFERENCES devices(id),
      source          TEXT NOT NULL,
      provider        TEXT,
      project         TEXT NOT NULL,
      repo_id         INT REFERENCES repos(id),
      title           TEXT,
      first_ts        TIMESTAMPTZ,
      last_ts         TIMESTAMPTZ,
      user_msgs       INT DEFAULT 0,
      assistant_msgs  INT DEFAULT 0,
      tool_calls      INT DEFAULT 0,
      tool_errors     INT DEFAULT 0,
      events          INT DEFAULT 0,
      tokens_in       BIGINT DEFAULT 0,
      tokens_out      BIGINT DEFAULT 0,
      tokens_cache_read  BIGINT DEFAULT 0,
      tokens_cache_write BIGINT DEFAULT 0,
      tokens_reasoning   BIGINT DEFAULT 0,
      model           TEXT,
      version         TEXT,
      branch          TEXT,
      cwd             TEXT,
      in_turn         BOOLEAN DEFAULT FALSE,
      current_turn_id TEXT,
      last_boundary_ts TIMESTAMPTZ,
      outstanding_tools JSONB DEFAULT '{}',
      last_user_prompt TEXT,
      top_files_read   JSONB DEFAULT '[]',
      top_files_edited JSONB DEFAULT '[]',
      top_files_written JSONB DEFAULT '[]',
      tool_use_names   JSONB DEFAULT '{}',
      queued           JSONB DEFAULT '[]',
      recent_events    JSONB DEFAULT '[]',
      server_line_seq  BIGINT DEFAULT 0,
      prefix_hash      TEXT
    )
  `);
  await db.execute(sql`CREATE INDEX ON sessions (user_id, last_ts DESC)`);
  await db.execute(sql`CREATE INDEX ON sessions (repo_id, last_ts DESC)`);

  await db.execute(sql`
    CREATE TABLE events (
      session_id      UUID NOT NULL REFERENCES sessions(session_id),
      line_seq        BIGINT NOT NULL,
      user_id         INT NOT NULL,
      project         TEXT NOT NULL,
      source          TEXT NOT NULL,
      ts              TIMESTAMPTZ NOT NULL,
      raw_type        TEXT NOT NULL,
      kind            TEXT NOT NULL,
      turn_id         TEXT,
      call_id         TEXT,
      event_id        TEXT,
      parent_id       TEXT,
      payload         JSONB NOT NULL,
      ingested_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (session_id, line_seq)
    )
  `);
  await db.execute(sql`CREATE INDEX ON events (session_id, ts)`);
  await db.execute(sql`CREATE INDEX ON events (user_id, project, ts DESC)`);
  await db.execute(
    sql`CREATE INDEX ON events (session_id, call_id) WHERE call_id IS NOT NULL`
  );
  await db.execute(
    sql`CREATE INDEX ON events (session_id, turn_id) WHERE turn_id IS NOT NULL`
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX ON events (event_id) WHERE event_id IS NOT NULL`
  );

  await db.execute(sql`
    CREATE TABLE heartbeats (
      session_id      UUID PRIMARY KEY REFERENCES sessions(session_id),
      user_id         INT NOT NULL,
      device_id       INT,
      pid             INT,
      kind            TEXT,
      updated_at      TIMESTAMPTZ
    )
  `);
}

// ── Test Helpers ─────────────────────────────────────────────

export function getCookie(res: Response, name: string): string | null {
  const header = res.headers.get("set-cookie") || "";
  // May have multiple cookies separated by comma in some runtimes
  const cookies = header.split(",").map((s) => s.trim());
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) {
      return c.split(";")[0]; // "name=value"
    }
  }
  return null;
}

export function makeEvent(overrides: Partial<{
  uuid: string;
  type: string;
  timestamp: string;
  sessionId: string;
  parentUuid: string | null;
}> = {}) {
  return {
    uuid: overrides.uuid ?? crypto.randomUUID(),
    type: overrides.type ?? "user",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    sessionId: overrides.sessionId ?? crypto.randomUUID(),
    parentUuid: overrides.parentUuid ?? null,
    message: { content: "test message" },
  };
}

export function makeNdjson(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
