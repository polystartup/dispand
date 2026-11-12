ALTER TABLE "questions" ADD COLUMN "consult_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_consult_id_questions_id_fk" FOREIGN KEY ("consult_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_consult_idx" ON "questions" USING btree ("consult_id");