import {
  pgTable,
  serial,
  text,
  bigint,
  boolean,
  timestamp,
  integer,
  uuid,
  numeric,
  jsonb,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

// ── Users & Auth ────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).unique().notNull(),
  githubLogin: text("github_login").notNull(),
  avatarUrl: text("avatar_url"),
  displayName: text("display_name"),
  githubToken: text("github_token").notNull(), // encrypted at rest
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").unique().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  deviceName: text("device_name").notNull(),
  os: text("os"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  deviceId: integer("device_id")
    .references(() => devices.id, { onDelete: "cascade" })
    .notNull(),
  keyHash: text("key_hash").unique().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const setupTokens = pgTable("setup_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  token: text("token").unique().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemed: boolean("redeemed").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Repos & Social Graph ────────────────────────────────────

export const repos = pgTable("repos", {
  id: serial("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).unique().notNull(),
  fullName: text("full_name").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  private: boolean("private").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const userRepos = pgTable(
  "user_repos",
  {
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    repoId: integer("repo_id")
      .references(() => repos.id, { onDelete: "cascade" })
      .notNull(),
    permission: text("permission").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.repoId] }),
    index("user_repos_repo_id_idx").on(t.repoId),
  ]
);

export const deviceExcludedRepos = pgTable(
  "device_excluded_repos",
  {
    deviceId: integer("device_id")
      .references(() => devices.id, { onDelete: "cascade" })
      .notNull(),
    repoId: integer("repo_id")
      .references(() => repos.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.repoId] })]
);

// ── Sessions & Events ───────────────────────────────────────

export const sessions = pgTable(
  "sessions",
  {
    sessionId: uuid("session_id").primaryKey(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    deviceId: integer("device_id").references(() => devices.id),
    project: text("project").notNull(),
    repoId: integer("repo_id").references(() => repos.id),
    title: text("title"),
    firstTs: timestamp("first_ts", { withTimezone: true }),
    lastTs: timestamp("last_ts", { withTimezone: true }),
    userMsgs: integer("user_msgs").default(0),
    assistantMsgs: integer("assistant_msgs").default(0),
    toolCalls: integer("tool_calls").default(0),
    toolErrors: integer("tool_errors").default(0),
    events: integer("events").default(0),
    tokensIn: bigint("tokens_in", { mode: "number" }).default(0),
    tokensCw5: bigint("tokens_cw5", { mode: "number" }).default(0),
    tokensCw1: bigint("tokens_cw1", { mode: "number" }).default(0),
    tokensCr: bigint("tokens_cr", { mode: "number" }).default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 4 }).default("0"),
    model: text("model"),
    version: text("version"),
    branch: text("branch"),
    cwd: text("cwd"),
    inTurn: boolean("in_turn").default(false),
    lastBoundaryTs: timestamp("last_boundary_ts", { withTimezone: true }),
    outstandingTools: jsonb("outstanding_tools").default({}),
    lastUserPrompt: text("last_user_prompt"),
    topFilesRead: jsonb("top_files_read").default([]),
    topFilesEdited: jsonb("top_files_edited").default([]),
    topFilesWritten: jsonb("top_files_written").default([]),
    toolUseNames: jsonb("tool_use_names").default({}),
    queued: jsonb("queued").default([]),
    recentEvents: jsonb("recent_events").default([]),
    serverOffset: bigint("server_offset", { mode: "number" }).default(0),
    prefixHash: text("prefix_hash"),
  },
  (t) => [
    index("sessions_user_last_ts_idx").on(t.userId, t.lastTs),
    index("sessions_repo_last_ts_idx").on(t.repoId, t.lastTs),
  ]
);

export const events = pgTable(
  "events",
  {
    uuid: uuid("uuid").primaryKey(),
    userId: integer("user_id").notNull(),
    sessionId: uuid("session_id")
      .references(() => sessions.sessionId)
      .notNull(),
    project: text("project").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    type: text("type").notNull(),
    parentUuid: uuid("parent_uuid"),
    byteOffset: bigint("byte_offset", { mode: "number" }),
    payload: jsonb("payload").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("events_session_ts_idx").on(t.sessionId, t.ts)]
);

export const heartbeats = pgTable("heartbeats", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.sessionId),
  userId: integer("user_id").notNull(),
  deviceId: integer("device_id"),
  pid: integer("pid"),
  kind: text("kind"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});
