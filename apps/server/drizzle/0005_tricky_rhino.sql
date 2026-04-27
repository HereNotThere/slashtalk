CREATE TABLE "agent_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_login" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"mode" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"name" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"last_activity" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text,
	"summary_model" text,
	"summary_ts" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_session_id_key" ON "agent_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_user_started_idx" ON "agent_sessions" USING btree ("user_login","started_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_started_idx" ON "agent_sessions" USING btree ("agent_id","started_at");