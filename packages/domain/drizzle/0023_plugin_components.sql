ALTER TABLE "agents" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "plugin_component" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "url_sealed" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "plugin_component" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;