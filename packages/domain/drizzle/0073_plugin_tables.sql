DROP INDEX "tables_owner_name_idx";--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "plugin_field" text;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "plugin_component" text;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tables_owner_name_idx" ON "tables" USING btree ("owner_id",coalesce("plugin_id", ''),lower("name"));