ALTER TABLE "users" ADD COLUMN "github_app_user_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_app_refresh_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_app_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_app_refresh_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_app_connected_at" timestamp with time zone;