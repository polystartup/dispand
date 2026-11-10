CREATE TABLE "runner_events" (
	"owner_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"seq" integer NOT NULL,
	"session_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "runner_events_runner_id_seq_pk" PRIMARY KEY("runner_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runner_pairings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "runner_pairings_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"clis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "runners_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "runner_events" ADD CONSTRAINT "runner_events_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_events" ADD CONSTRAINT "runner_events_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairings" ADD CONSTRAINT "runner_pairings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairings" ADD CONSTRAINT "runner_pairings_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;