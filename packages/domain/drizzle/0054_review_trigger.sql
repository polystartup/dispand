ALTER TABLE "triggers" ADD COLUMN "built_in" text;--> statement-breakpoint
CREATE UNIQUE INDEX "triggers_one_review_idx" ON "triggers" USING btree ("agent_id") WHERE "triggers"."built_in" = 'review';