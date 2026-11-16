CREATE TABLE "plugin_files" (
	"plugin_id" text NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "plugin_files_plugin_id_path_pk" PRIMARY KEY("plugin_id","path")
);
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "digest" text;--> statement-breakpoint
ALTER TABLE "plugin_files" ADD CONSTRAINT "plugin_files_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;