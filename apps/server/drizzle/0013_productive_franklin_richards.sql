CREATE TABLE "room_members" (
	"room_id" uuid NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "room_messages" (
	"seq" serial PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"author_user_id" integer,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_login" text NOT NULL,
	"repo_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"agent_def" jsonb NOT NULL,
	"sandbox_provider" text NOT NULL,
	"sandbox_id" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"destroyed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_orgs" (
	"user_id" integer NOT NULL,
	"org_login" text NOT NULL,
	"role" text,
	"refreshed_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_orgs_user_id_org_login_pk" PRIMARY KEY("user_id","org_login")
);
--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_orgs" ADD CONSTRAINT "user_orgs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_members_user_id_idx" ON "room_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "room_messages_room_seq_idx" ON "room_messages" USING btree ("room_id","seq");--> statement-breakpoint
CREATE INDEX "rooms_org_login_idx" ON "rooms" USING btree ("org_login");--> statement-breakpoint
CREATE INDEX "rooms_repo_id_idx" ON "rooms" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "rooms_status_last_activity_idx" ON "rooms" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE INDEX "user_orgs_org_login_idx" ON "user_orgs" USING btree ("org_login");