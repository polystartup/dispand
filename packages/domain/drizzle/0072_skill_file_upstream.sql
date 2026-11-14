CREATE TABLE "skill_file_upstream" (
	"package_id" text NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "skill_file_upstream_package_id_path_pk" PRIMARY KEY("package_id","path")
);
--> statement-breakpoint
ALTER TABLE "skill_file_upstream" ADD CONSTRAINT "skill_file_upstream_package_id_skill_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."skill_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "skill_file_upstream" ("package_id", "path", "content") SELECT f."package_id", f."path", f."content" FROM "skill_files" f JOIN "skill_packages" p ON p."id" = f."package_id" WHERE p."plugin_id" IS NOT NULL;
