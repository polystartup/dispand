ALTER TABLE "questions" ADD COLUMN "answer_by" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "questions_answer_by_idx" ON "questions" USING btree ("answer_by") WHERE "questions"."status" = 'pending';--> statement-breakpoint
-- A routed question already waiting gets its full 72 h from now.
UPDATE "questions" SET "answer_by" = now() + interval '72 hours' WHERE "status" = 'pending' AND "route" IS NOT NULL;
