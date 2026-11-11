ALTER TABLE "tables" ADD COLUMN "primitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "parent_field_id" text;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "parent_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_parent_field_id_fields_id_fk" FOREIGN KEY ("parent_field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;