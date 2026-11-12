CREATE TABLE "audit" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" jsonb NOT NULL,
	"actor_agent_id" text,
	"job_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"result" text NOT NULL,
	"details" jsonb NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "audit_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_owner_at_idx" ON "audit" USING btree ("owner_id","at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_owner_job_idx" ON "audit" USING btree ("owner_id","job_id","at");--> statement-breakpoint
CREATE INDEX "audit_owner_action_idx" ON "audit" USING btree ("owner_id","action","at");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit" USING btree ("at");--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_audit_retention_range" CHECK ("workspace_settings"."audit_retention_days" between 1 and 3650);