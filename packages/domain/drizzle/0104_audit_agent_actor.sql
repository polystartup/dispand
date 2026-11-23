-- A trigger's firing or poll is the agent's, not the scheduler's: rows the scheduler wrote for an
-- agent name it as their actor.
UPDATE "audit" SET "actor" = jsonb_build_object('type', 'agent', 'agentId', "actor_agent_id") WHERE "actor"->>'type' = 'scheduler' AND "actor_agent_id" IS NOT NULL;
