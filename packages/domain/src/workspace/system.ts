import { PROTOCOL_VERSION } from "@dispand/runner-protocol";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { agents, polls, triggers } from "../db/schema.ts";
import { STALE_TICK_MS } from "../engine/scheduler.ts";
import { managerProcedure } from "../rpc/context.ts";
import { workspaceRunners } from "../runners/procedures.ts";
import { visible } from "../triggers/procedures.ts";

/**
 * What a workspace's managers check when something seems wrong (the System page): its runners and
 * their protocol against the server's, how long ago this process's scheduler last ticked, and its
 * poll triggers whose latest poll failed. Only the workspace's own rows: the tick's age is the one
 * install-wide fact, and `/api/health` already tells it to anyone.
 */
const status = managerProcedure.handler(async ({ context }) => {
  const { workspaceId } = context.access;
  const since = context.scheduler?.sinceTick();
  // Each enabled poll trigger's latest poll that ended (one under way says nothing yet), among those the person sees.
  const latest = context.db
    .selectDistinctOn([polls.triggerId], {
      triggerId: polls.triggerId,
      triggerName: sql<string>`${triggers.name}`.as("trigger_name"),
      agentId: agents.id,
      agentName: sql<string>`${agents.name}`.as("agent_name"),
      at: polls.at,
      status: polls.status,
      message: polls.message,
    })
    .from(polls)
    .innerJoin(triggers, eq(triggers.id, polls.triggerId))
    .innerJoin(agents, eq(agents.id, triggers.agentId))
    .where(and(visible(workspaceId, context.actorId), eq(triggers.kind, "poll"), eq(triggers.enabled, true), ne(polls.status, "calling")))
    .orderBy(polls.triggerId, desc(polls.at), desc(polls.id))
    .as("latest");
  const failingPolls = await context.db
    .select({
      triggerId: latest.triggerId,
      triggerName: latest.triggerName,
      agentId: latest.agentId,
      agentName: latest.agentName,
      at: latest.at,
      message: latest.message,
    })
    .from(latest)
    .where(eq(latest.status, "failed"))
    .orderBy(desc(latest.at), latest.triggerId);
  return {
    protocolVersion: PROTOCOL_VERSION,
    // Null: this process runs no scheduler (another may).
    scheduler: since === undefined ? null : { sinceTickMs: since, stale: since > STALE_TICK_MS },
    runners: (await workspaceRunners(context)).map(({ runner: { id, name, status, lastSeenAt }, protocolVersion }) => ({
      id,
      name,
      status,
      protocolVersion,
      lastSeenAt,
    })),
    failingPolls,
  };
});

export const system = { status };
