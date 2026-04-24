import {
  pgTable,
  serial,
  text,
  bigint,
  boolean,
  timestamp,
  integer,
  uuid,
  jsonb,
  numeric,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EventKind, EventSource, Provider } from "@slashtalk/shared";

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

export const devices = pgTable(
  "devices",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    deviceName: text("device_name").notNull(),
    os: text("os"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("devices_user_name_unique").on(t.userId, t.deviceName)],
);

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
  // githubId is only populated if we have push/repo scope — with read-only
  // OAuth (read:user read:org) we identify repos by full_name instead.
  githubId: bigint("github_id", { mode: "number" }).unique(),
  fullName: text("full_name").unique().notNull(),
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

export const deviceRepoPaths = pgTable(
  "device_repo_paths",
  {
    deviceId: integer("device_id")
      .references(() => devices.id, { onDelete: "cascade" })
      .notNull(),
    repoId: integer("repo_id")
      .references(() => repos.id, { onDelete: "cascade" })
      .notNull(),
    localPath: text("local_path").notNull(),
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
    source: text("source").$type<EventSource>().notNull(),
    provider: text("provider").$type<Provider>(),
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
    tokensOut: bigint("tokens_out", { mode: "number" }).default(0),
    tokensCacheRead: bigint("tokens_cache_read", { mode: "number" }).default(0),
    tokensCacheWrite: bigint("tokens_cache_write", {
      mode: "number",
    }).default(0),
    tokensReasoning: bigint("tokens_reasoning", { mode: "number" }).default(0),
    model: text("model"),
    version: text("version"),
    branch: text("branch"),
    cwd: text("cwd"),
    inTurn: boolean("in_turn").default(false),
    currentTurnId: text("current_turn_id"),
    lastBoundaryTs: timestamp("last_boundary_ts", { withTimezone: true }),
    outstandingTools: jsonb("outstanding_tools").default({}),
    lastUserPrompt: text("last_user_prompt"),
    topFilesRead: jsonb("top_files_read").default([]),
    topFilesEdited: jsonb("top_files_edited").default([]),
    topFilesWritten: jsonb("top_files_written").default([]),
    toolUseNames: jsonb("tool_use_names").default({}),
    queued: jsonb("queued").default([]),
    recentEvents: jsonb("recent_events").default([]),
    serverLineSeq: bigint("server_line_seq", { mode: "number" }).default(0),
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
    sessionId: uuid("session_id")
      .references(() => sessions.sessionId)
      .notNull(),
    lineSeq: bigint("line_seq", { mode: "number" }).notNull(),
    userId: integer("user_id").notNull(),
    project: text("project").notNull(),
    source: text("source").$type<EventSource>().notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    rawType: text("raw_type").notNull(),
    kind: text("kind").$type<EventKind>().notNull(),
    turnId: text("turn_id"),
    callId: text("call_id"),
    eventId: text("event_id"),
    parentId: text("parent_id"),
    payload: jsonb("payload").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.lineSeq] }),
    index("events_session_ts_idx").on(t.sessionId, t.ts),
    index("events_user_project_ts_idx").on(t.userId, t.project, t.ts),
    index("events_call_idx")
      .on(t.sessionId, t.callId)
      .where(sql`call_id is not null`),
    index("events_turn_idx")
      .on(t.sessionId, t.turnId)
      .where(sql`turn_id is not null`),
    uniqueIndex("events_event_id_idx")
      .on(t.eventId)
      .where(sql`event_id is not null`),
  ]
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

// ── Pull Requests ───────────────────────────────────────────

/** PRs seen by the social/pr-poller. Persisted so we can render a PR link
 *  alongside any session whose (repo_id, branch) matches head_ref. The poller
 *  only sees recent events from user activity feeds, so coverage is best-effort
 *  — absence here does not mean "no PR exists", only "we haven't seen one". */
export const pullRequests = pgTable(
  "pull_requests",
  {
    repoId: integer("repo_id")
      .references(() => repos.id, { onDelete: "cascade" })
      .notNull(),
    number: integer("number").notNull(),
    headRef: text("head_ref").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    state: text("state").$type<"open" | "closed" | "merged">().notNull(),
    authorLogin: text("author_login").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.number] }),
    index("pull_requests_repo_head_ref_idx").on(t.repoId, t.headRef),
  ],
);

// ── Session Insights (LLM-derived) ──────────────────────────

export const sessionInsights = pgTable(
  "session_insights",
  {
    sessionId: uuid("session_id")
      .references(() => sessions.sessionId, { onDelete: "cascade" })
      .notNull(),
    analyzerName: text("analyzer_name").notNull(),
    analyzerVersion: text("analyzer_version").notNull(),
    output: jsonb("output").notNull(),
    inputLineSeq: bigint("input_line_seq", { mode: "number" })
      .notNull()
      .default(0),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").default(0),
    tokensOut: integer("tokens_out").default(0),
    tokensCacheRead: integer("tokens_cache_read").default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).default("0"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).defaultNow(),
    errorText: text("error_text"),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.analyzerName] }),
    index("session_insights_analyzed_at_idx").on(t.analyzedAt),
  ],
);
