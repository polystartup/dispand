ALTER TABLE "agents" ADD COLUMN "built_in" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_assistant_idx" ON "agents" USING btree ("owner_id") WHERE "agents"."built_in" = 'assistant';