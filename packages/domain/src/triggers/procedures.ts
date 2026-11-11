import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { agents, eventFires, fields, tables, triggerFires, triggers as triggersTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { cronProblem, nextFireAfter } from "../workflows/schedule.ts";
import { Concurrency, RateCap, TriggerConfig, TriggerFields } from "./model.ts";

const owner = base.use(authed);

type Row = typeof triggersTable.$inferSelect;
type Times = Pick<Row, "nextFireAt" | "lastCheckedAt">;

async function requireAgent(db: Db | Tx, ownerId: string, agentId: string) {
  const [row] = await db
    .select({ id: agents.id, bundles: agents.bundles, dataTables: agents.dataTables })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
  return row;
}

/** A chat starts with the owner's words; a button or a schedule has only its instructions to go on. */
function checkInstructions(config: TriggerConfig, instructions: string) {
  if (config.kind === "manual" && config.placement === "chat") return;
  if (!instructions.trim()) throw new ORPCError("BAD_REQUEST", { message: "Say what the agent does when this trigger fires" });
}

/**
 * A schedule's cron must parse. A primitive trigger watches a primitive table of the owner's,
 * its fields, and reads no more than its agent may: the agent has `data` on that table.
 */
async function checkConfig(db: Db | Tx, ownerId: string, agent: Awaited<ReturnType<typeof requireAgent>>, config: TriggerConfig) {
  if (config.kind === "schedule") {
    const problem = cronProblem(config.cron, config.timezone);
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
  }
  if (config.kind !== "primitive") return;
  const [table] = await db
    .select({ primitive: tables.primitive })
    .from(tables)
    .where(and(eq(tables.id, config.tableId), eq(tables.ownerId, ownerId)));
  if (!table) throw new ORPCError("NOT_FOUND", { message: "Table not found" });
  if (!table.primitive) throw new ORPCError("BAD_REQUEST", { message: "Only a primitive table's changes start Jobs: make the table primitive first" });
  if (config.fields) {
    const found = await db.select({ id: fields.id }).from(fields).where(and(eq(fields.tableId, config.tableId), inArray(fields.id, config.fields)));
    if (found.length !== new Set(config.fields).size) throw new ORPCError("BAD_REQUEST", { message: "A watched field isn't one of the table's" });
  }
  if (!agent.bundles.includes("data") || (agent.dataTables !== "all" && !agent.dataTables.includes(config.tableId))) {
    throw new ORPCError("BAD_REQUEST", { message: "The agent can't read this table: give it data on the table first" });
  }
}

/**
 * When a trigger next fires. A manual trigger has no times. A schedule keeps its times unless
 * it is new, its cron or timezone changed, or it is enabled again: then it fires from `now` on,
 * with no catch-up, as workflow schedules do.
 */
export function scheduleColumns(config: TriggerConfig, previous: (Times & { config: TriggerConfig; enabled: boolean }) | null, enabled: boolean, now: Date): Times {
  if (config.kind !== "schedule") return { nextFireAt: null, lastCheckedAt: null };
  const same =
    previous?.config.kind === "schedule" && previous.config.cron === config.cron && previous.config.timezone === config.timezone;
  const resumed = previous && !previous.enabled && enabled;
  if (previous && same && !resumed) return { nextFireAt: previous.nextFireAt, lastCheckedAt: previous.lastCheckedAt };
  return { nextFireAt: nextFireAfter(config.cron, config.timezone, now), lastCheckedAt: now };
}

async function view(db: Db, row: Row) {
  const events =
    row.kind === "primitive"
      ? await db.select().from(eventFires).where(eq(eventFires.triggerId, row.id)).orderBy(desc(eventFires.createdAt), desc(eventFires.id)).limit(5)
      : [];
  const fires =
    row.kind === "schedule"
      ? await db
          .select()
          .from(triggerFires)
          .where(eq(triggerFires.triggerId, row.id))
          .orderBy(desc(triggerFires.scheduledFor))
          .limit(5)
      : [];
  const { id, agentId, name, kind, enabled, instructions, concurrency, rateCap, config, nextFireAt } = row;
  return {
    id,
    agentId,
    name,
    kind,
    enabled,
    instructions,
    concurrency,
    rateCap,
    config,
    ...(nextFireAt ? { nextFireAt } : {}),
    lastFires: fires.map((f) => ({
      scheduledFor: f.scheduledFor,
      status: f.status,
      ...(f.runId ? { runId: f.runId } : {}),
      ...(f.message ? { message: f.message } : {}),
    })),
    // A primitive trigger's latest events: what each did.
    lastEvents: events.map((f) => ({
      eventId: f.eventId,
      at: f.createdAt,
      status: f.status,
      ...(f.runId ? { runId: f.runId } : {}),
      ...(f.message ? { message: f.message } : {}),
    })),
  };
}

async function find(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.id, id), eq(triggersTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

const create = owner.input(TriggerFields.extend({ agentId: z.string() })).handler(async ({ input, context }) => {
  const agent = await requireAgent(context.db, context.ownerId, input.agentId);
  await checkConfig(context.db, context.ownerId, agent, input.config);
  checkInstructions(input.config, input.instructions);
  const now = (context.now ?? (() => new Date()))();
  const { agentId, name, instructions, concurrency, rateCap, config } = input;
  const [row] = await context.db
    .insert(triggersTable)
    .values({
      id: newId("trigger"),
      ownerId: context.ownerId,
      agentId,
      kind: config.kind,
      name,
      instructions,
      concurrency,
      rateCap,
      config,
      ...scheduleColumns(config, null, true, now),
    })
    .returning();
  return view(context.db, row!);
});

const update = owner
  .input(
    z.object({
      id: z.string(),
      name: TriggerFields.shape.name.optional(),
      enabled: z.boolean().optional(),
      instructions: TriggerFields.shape.instructions.unwrap().optional(),
      concurrency: Concurrency.optional(),
      rateCap: RateCap.optional(),
      config: TriggerConfig.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const now = (context.now ?? (() => new Date()))();
    const row = await context.db.transaction(async (tx) => {
      // Locked: the scheduler moves a schedule's times under the same lock.
      const [previous] = await tx
        .select()
        .from(triggersTable)
        .where(and(eq(triggersTable.id, input.id), eq(triggersTable.ownerId, context.ownerId)))
        .for("update");
      if (!previous) throw new ORPCError("NOT_FOUND");
      const config = input.config ?? previous.config;
      if (config.kind !== previous.kind) throw new ORPCError("BAD_REQUEST", { message: "A trigger's kind can't change" });
      // A primitive trigger can always be turned off, even once what it watches has changed under
      // it: its config is checked when it is turned on again. A schedule's cron is always checked.
      if ((input.enabled ?? previous.enabled) || config.kind !== "primitive") await checkConfig(tx, context.ownerId, await requireAgent(tx, context.ownerId, previous.agentId), config);
      checkInstructions(config, input.instructions ?? previous.instructions);
      const enabled = input.enabled ?? previous.enabled;
      const [updated] = await tx
        .update(triggersTable)
        .set({
          name: input.name ?? previous.name,
          instructions: input.instructions ?? previous.instructions,
          concurrency: input.concurrency ?? previous.concurrency,
          rateCap: input.rateCap ?? previous.rateCap,
          enabled,
          config,
          ...scheduleColumns(config, previous, enabled, now),
          updatedAt: now,
        })
        .where(eq(triggersTable.id, input.id))
        .returning();
      return updated!;
    });
    return view(context.db, row);
  });

const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await find(context.db, context.ownerId, input.id);
  await context.db.delete(triggersTable).where(eq(triggersTable.id, input.id));
});

const list = owner.input(z.object({ agentId: z.string() })).handler(async ({ input, context }) => {
  await requireAgent(context.db, context.ownerId, input.agentId);
  const rows = await context.db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.agentId, input.agentId), eq(triggersTable.ownerId, context.ownerId)))
    .orderBy(asc(triggersTable.createdAt), asc(triggersTable.id));
  return Promise.all(rows.map((row) => view(context.db, row)));
});

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  return view(context.db, await find(context.db, context.ownerId, input.id));
});

export const triggers = { create, update, delete: remove, list, get };
