CREATE TABLE "skill_files" (
	"package_id" text NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "skill_files_package_id_path_pk" PRIMARY KEY("package_id","path")
);
--> statement-breakpoint
CREATE TABLE "skill_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"plugin_id" text,
	"required_tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_packages_owner_name" UNIQUE("owner_id","name")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "skills_package_name" UNIQUE("package_id","name")
);
--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_package_id_skill_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."skill_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_package_id_skill_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."skill_packages"("id") ON DELETE cascade ON UPDATE no action;