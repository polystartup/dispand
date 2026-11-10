import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { stepRuns, triggers } from "../db/schema.ts";
import { authed, base } from "../rpc/context.ts";
import { engineError } from "../workflows/procedures.ts";

const owner = base.use(authed);

/** Starts a Job of a manual trigger; a chat placement also gives the conversation's session. */
const start = owner.input(z.object({ triggerId: z.string() })).handler(async ({ input, context }) => {
  const [trigger] = await context.db
    .select()
    .from(triggers)
    .where(and(eq(triggers.id, input.triggerId), eq(triggers.ownerId, context.ownerId)));
  if (!trigger) throw new ORPCError("NOT_FOUND");
  if (trigger.config.kind !== "manual") throw new ORPCError("BAD_REQUEST", { message: "Only a manual trigger can be started by hand" });
  if (!trigger.enabled) throw new ORPCError("BAD_REQUEST", { message: "This trigger is disabled" });
  const runId = await context.engine.startJob(trigger.id, context.ownerId).catch(engineError);
  if (trigger.config.placement !== "chat") return { runId };
  const [chat] = await context.db
    .select({ sessionId: stepRuns.sessionId })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, trigger.id)));
  return { runId, ...(chat?.sessionId ? { chatSessionId: chat.sessionId } : {}) };
});

export const jobs = { start };
