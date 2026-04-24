CREATE TABLE "pull_requests" (
	"repo_id" integer NOT NULL,
	"number" integer NOT NULL,
	"head_ref" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"author_login" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pull_requests_repo_id_number_pk" PRIMARY KEY("repo_id","number")
);
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pull_requests_repo_head_ref_idx" ON "pull_requests" USING btree ("repo_id","head_ref");