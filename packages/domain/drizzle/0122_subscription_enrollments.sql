CREATE TABLE "subscription_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_challenges_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "subscription_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"user_id" text NOT NULL,
	"harness" text NOT NULL,
	"identity" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_enrollments_runner_id_harness_unique" UNIQUE("runner_id","harness")
);
--> statement-breakpoint
ALTER TABLE "subscription_challenges" ADD CONSTRAINT "subscription_challenges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_challenges" ADD CONSTRAINT "subscription_challenges_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_challenges" ADD CONSTRAINT "subscription_challenges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_enrollments" ADD CONSTRAINT "subscription_enrollments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_enrollments" ADD CONSTRAINT "subscription_enrollments_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_enrollments" ADD CONSTRAINT "subscription_enrollments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;