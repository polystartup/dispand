ALTER TABLE "step_runs" DROP CONSTRAINT "step_runs_run_id_node_id_unique";--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "iteration" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_run_id_node_id_iteration_unique" UNIQUE("run_id","node_id","iteration");