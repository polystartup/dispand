ALTER TABLE "questions" ADD COLUMN "consult_run_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_consult_run_id_runs_id_fk" FOREIGN KEY ("consult_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_consult_run_idx" ON "questions" USING btree ("consult_run_id");