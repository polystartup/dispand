ALTER TABLE "event_fires" DROP CONSTRAINT "event_fires_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "poll_items" DROP CONSTRAINT "poll_items_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "polls" DROP CONSTRAINT "polls_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "schedule_fires" DROP CONSTRAINT "schedule_fires_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "trigger_fires" DROP CONSTRAINT "trigger_fires_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "triggers" DROP CONSTRAINT "triggers_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "event_fires" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poll_items" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "polls" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_fires" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_fires" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "triggers" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event_fires" ADD CONSTRAINT "event_fires_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_items" ADD CONSTRAINT "poll_items_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_fires" ADD CONSTRAINT "schedule_fires_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_fires" ADD CONSTRAINT "trigger_fires_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;