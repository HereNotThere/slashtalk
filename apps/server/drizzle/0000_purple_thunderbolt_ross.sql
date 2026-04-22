CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"device_id" integer NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "device_excluded_repos" (
	"device_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	CONSTRAINT "device_excluded_repos_device_id_repo_id_pk" PRIMARY KEY("device_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"device_name" text NOT NULL,
	"os" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"session_id" uuid NOT NULL,
	"line_seq" bigint NOT NULL,
	"user_id" integer NOT NULL,
	"project" text NOT NULL,
	"source" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"raw_type" text NOT NULL,
	"kind" text NOT NULL,
	"turn_id" text,
	"call_id" text,
	"event_id" text,
	"parent_id" text,
	"payload" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "events_session_id_line_seq_pk" PRIMARY KEY("session_id","line_seq")
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"device_id" integer,
	"pid" integer,
	"kind" text,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"private" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "repos_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"device_id" integer,
	"source" text NOT NULL,
	"provider" text,
	"project" text NOT NULL,
	"repo_id" integer,
	"title" text,
	"first_ts" timestamp with time zone,
	"last_ts" timestamp with time zone,
	"user_msgs" integer DEFAULT 0,
	"assistant_msgs" integer DEFAULT 0,
	"tool_calls" integer DEFAULT 0,
	"tool_errors" integer DEFAULT 0,
	"events" integer DEFAULT 0,
	"tokens_in" bigint DEFAULT 0,
	"tokens_out" bigint DEFAULT 0,
	"tokens_cache_read" bigint DEFAULT 0,
	"tokens_cache_write" bigint DEFAULT 0,
	"tokens_reasoning" bigint DEFAULT 0,
	"model" text,
	"version" text,
	"branch" text,
	"cwd" text,
	"in_turn" boolean DEFAULT false,
	"current_turn_id" text,
	"last_boundary_ts" timestamp with time zone,
	"outstanding_tools" jsonb DEFAULT '{}'::jsonb,
	"last_user_prompt" text,
	"top_files_read" jsonb DEFAULT '[]'::jsonb,
	"top_files_edited" jsonb DEFAULT '[]'::jsonb,
	"top_files_written" jsonb DEFAULT '[]'::jsonb,
	"tool_use_names" jsonb DEFAULT '{}'::jsonb,
	"queued" jsonb DEFAULT '[]'::jsonb,
	"recent_events" jsonb DEFAULT '[]'::jsonb,
	"server_line_seq" bigint DEFAULT 0,
	"prefix_hash" text
);
--> statement-breakpoint
CREATE TABLE "setup_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "setup_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user_repos" (
	"user_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"permission" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_repos_user_id_repo_id_pk" PRIMARY KEY("user_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"avatar_url" text,
	"display_name" text,
	"github_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_excluded_repos" ADD CONSTRAINT "device_excluded_repos_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_excluded_repos" ADD CONSTRAINT "device_excluded_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_repos" ADD CONSTRAINT "user_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_repos" ADD CONSTRAINT "user_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_session_ts_idx" ON "events" USING btree ("session_id","ts");--> statement-breakpoint
CREATE INDEX "events_user_project_ts_idx" ON "events" USING btree ("user_id","project","ts");--> statement-breakpoint
CREATE INDEX "events_call_idx" ON "events" USING btree ("session_id","call_id") WHERE call_id is not null;--> statement-breakpoint
CREATE INDEX "events_turn_idx" ON "events" USING btree ("session_id","turn_id") WHERE turn_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "events_event_id_idx" ON "events" USING btree ("event_id") WHERE event_id is not null;--> statement-breakpoint
CREATE INDEX "sessions_user_last_ts_idx" ON "sessions" USING btree ("user_id","last_ts");--> statement-breakpoint
CREATE INDEX "sessions_repo_last_ts_idx" ON "sessions" USING btree ("repo_id","last_ts");--> statement-breakpoint
CREATE INDEX "user_repos_repo_id_idx" ON "user_repos" USING btree ("repo_id");