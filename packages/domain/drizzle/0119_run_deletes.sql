ALTER TABLE "chat_queue" DROP CONSTRAINT "chat_queue_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "roots" DROP CONSTRAINT "roots_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_queue" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_queue" ADD CONSTRAINT "chat_queue_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roots" ADD CONSTRAINT "roots_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;