ALTER TABLE "widgets" ALTER COLUMN "workflow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "widgets" ADD COLUMN "table_id" text;--> statement-breakpoint
ALTER TABLE "widgets" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widgets_table_idx" ON "widgets" USING btree ("table_id");--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_target_check" CHECK (("widgets"."type" = 'workflow-form' and "widgets"."workflow_id" is not null and "widgets"."table_id" is null and "widgets"."config" is null) or ("widgets"."type" in ('grid', 'table') and "widgets"."workflow_id" is null and "widgets"."table_id" is not null and "widgets"."config" is not null));