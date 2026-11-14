ALTER TABLE "triggers" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "plugin_component" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "upstream" jsonb;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "overridden" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;