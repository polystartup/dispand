ALTER TABLE "agents" DROP CONSTRAINT "agents_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A person's Assistant acts as them, and its chats are theirs alone: it goes with them, its Jobs
-- and chats first (deleting an agent keeps its Jobs). Every other agent stays, with no creator.
CREATE FUNCTION dispand_person_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM runs WHERE agent_id IN (SELECT id FROM agents WHERE owner_id = OLD.id AND built_in = 'assistant');
  DELETE FROM agents WHERE owner_id = OLD.id AND built_in = 'assistant';
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER user_deleted BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION dispand_person_deleted();
