ALTER TABLE "questions" ADD COLUMN "addressee_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "route" jsonb;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_addressee_id_user_id_fk" FOREIGN KEY ("addressee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_addressee_idx" ON "questions" USING btree ("addressee_id");--> statement-breakpoint
-- Every question but a consult (whose addressee is an agent) is addressed to whom it was asked of.
UPDATE "questions" SET "addressee_id" = "owner_id" WHERE "kind" <> 'consult';
