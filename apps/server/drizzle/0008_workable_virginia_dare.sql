DROP INDEX "agent_sessions_session_id_key";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credentials_revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_user_session_key" ON "agent_sessions" USING btree ("user_login","session_id");