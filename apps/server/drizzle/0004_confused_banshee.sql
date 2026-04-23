CREATE TABLE "session_insights" (
	"session_id" uuid NOT NULL,
	"analyzer_name" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"output" jsonb NOT NULL,
	"input_line_seq" bigint DEFAULT 0 NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0,
	"tokens_out" integer DEFAULT 0,
	"tokens_cache_read" integer DEFAULT 0,
	"cost_usd" numeric(10, 6) DEFAULT '0',
	"analyzed_at" timestamp with time zone DEFAULT now(),
	"error_text" text,
	CONSTRAINT "session_insights_session_id_analyzer_name_pk" PRIMARY KEY("session_id","analyzer_name")
);
--> statement-breakpoint
ALTER TABLE "session_insights" ADD CONSTRAINT "session_insights_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_insights_analyzed_at_idx" ON "session_insights" USING btree ("analyzed_at");