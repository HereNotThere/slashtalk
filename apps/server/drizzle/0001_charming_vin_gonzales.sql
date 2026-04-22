CREATE TABLE "device_repo_paths" (
	"device_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"local_path" text NOT NULL,
	CONSTRAINT "device_repo_paths_device_id_repo_id_pk" PRIMARY KEY("device_id","repo_id")
);
--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "github_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_repo_paths" ADD CONSTRAINT "device_repo_paths_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_repo_paths" ADD CONSTRAINT "device_repo_paths_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_full_name_unique" UNIQUE("full_name");