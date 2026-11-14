CREATE TABLE "plugin_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"kind" text NOT NULL,
	"element_id" text NOT NULL,
	"field" text NOT NULL,
	"old" jsonb,
	"mine" jsonb,
	"next" jsonb,
	"status" text NOT NULL,
	"merged" jsonb,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_conflicts" ADD CONSTRAINT "plugin_conflicts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_conflicts" ADD CONSTRAINT "plugin_conflicts_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_conflicts" ADD CONSTRAINT "plugin_conflicts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_conflicts_field_idx" ON "plugin_conflicts" USING btree ("kind","element_id","field");--> statement-breakpoint
CREATE INDEX "plugin_conflicts_run_idx" ON "plugin_conflicts" USING btree ("run_id");