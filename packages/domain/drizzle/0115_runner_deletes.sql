ALTER TABLE "harnesses" DROP CONSTRAINT "harnesses_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT "runners_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "harnesses" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;