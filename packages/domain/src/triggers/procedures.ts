import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { agents, eventFires, fields, plugins, pollItems, polls, tables, triggerFires, triggers as triggersTable } from "../db/schema.ts";
import { assistantGuard, type AgentChange } from "../agents/builtin.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { pollProblem } from "../tools/pollable.ts";
import { cronProblem, nextFireAfter } from "../workflows/schedule.ts";
import { overriddenAfter, refuseOwnDelete, sameValue } from "../plugins/overrides.ts";
import { canonicalJson, Concurrency, INTERACTION, RateCap, TriggerConfig, TriggerFields } from "./model.ts";

const owner = base.use(authed);

type Row = typeof triggersTable.$inferSelect;
type Times = Pick<Row, "nextFireAt" | "lastCheckedAt" | "pollCursor">;

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
 * its fields, and reads no more than its agent may: the agent has `data` on that table; or the
 * built-in `interaction`, for an agent with `inbox`. A poll
 * names an action of a tool its agent has, one a poll may read (`pollProblem`).
 */
async function checkConfig(db: Db | Tx, ownerId: string, agent: Awaited<ReturnType<typeof requireAgent>>, config: TriggerConfig) {
  if (config.kind === "schedule") {
    const problem = cronProblem(config.cron, config.timezone);
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
  }
  if (config.kind === "poll") {
    const problem = await pollProblem(db, ownerId, agent.id, config.toolId, config.action);
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
  }
  if (config.kind !== "primitive") return;
  // Questions and Approvals (the built-in `interaction`): only an agent with `inbox` is started by them.
  if (config.tableId === INTERACTION) {
    if (!agent.bundles.includes("inbox")) throw new ORPCError("BAD_REQUEST", { message: "Only an agent with the Inbox can be started by Questions: give it the Inbox first" });
    return;
  }
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
  if (config.kind === "poll") {
    // A poll is due at once when new, changed or turned on again (its baseline then recorded
    // again: `lastCheckedAt` null); a new interval counts from now. A walk under way keeps its
    // query; its continuation changed, it starts over from its first page (its token dropped), so
    // nothing it hadn't read yet falls before a moved `{{lastPoll}}`.
    const same = previous?.config.kind === "poll" && !rebaselines(previous, config, enabled);
    const sameInterval = same && previous.config.kind === "poll" && previous.config.interval === config.interval;
    const cursor = same ? previous.pollCursor : null;
    const sameWalk = previous?.config.kind === "poll" && canonicalJson(previous.config.continuation ?? null) === canonicalJson(config.continuation ?? null);
    return {
      nextFireAt: sameInterval ? previous.nextFireAt : now,
      lastCheckedAt: same ? previous.lastCheckedAt : null,
      pollCursor: cursor && !sameWalk ? { ...cursor, token: null } : cursor,
    };
  }
  if (config.kind !== "schedule") return { nextFireAt: null, lastCheckedAt: null, pollCursor: null };
  const same =
    previous?.config.kind === "schedule" && previous.config.cron === config.cron && previous.config.timezone === config.timezone;
  const resumed = previous && !previous.enabled && enabled;
  if (previous && same && !resumed) return { nextFireAt: previous.nextFireAt, lastCheckedAt: previous.lastCheckedAt, pollCursor: null };
  return { nextFireAt: nextFireAfter(config.cron, config.timezone, now), lastCheckedAt: now, pollCursor: null };
}

/**
 * Whether a poll trigger's next poll is a baseline again (it records what exists and starts
 * nothing): it calls something else now (tool, action, arguments, paths), or it is turned on again.
 */
export function rebaselines(previous: { config: TriggerConfig; enabled: boolean }, config: TriggerConfig, enabled: boolean): boolean {
  if (previous.config.kind !== "poll" || config.kind !== "poll") return false;
  const calls = (c: typeof config) => canonicalJson([c.toolId, c.action, c.arguments, c.itemsPath, c.idPath]);
  return calls(previous.config) !== calls(config) || (!previous.enabled && enabled);
}

/**
 * A poll trigger's latest polls, and the items each found new (the latest of them). An item's id
 * is what the tool read (it may be a subject line): a Job, which may not hold the tool, gets none.
 */
async function pollView(db: Db, triggerId: string, forJob: boolean) {
  const latest = await db.select().from(polls).where(eq(polls.triggerId, triggerId)).orderBy(desc(polls.at), desc(polls.id)).limit(5);
  const items = await db
    .select({ itemId: pollItems.itemId, firstSeen: pollItems.firstSeen, status: pollItems.status, runId: pollItems.runId, message: pollItems.message })
    .from(pollItems)
    .where(eq(pollItems.triggerId, triggerId))
    .orderBy(desc(pollItems.firstSeen), desc(pollItems.id))
    .limit(20);
  return latest.map((p) => ({
    at: p.at,
    status: p.status,
    found: p.found,
    fresh: p.fresh,
    ...(p.message ? { message: p.message } : {}),
    items: forJob
      ? []
      : items
      .filter((i) => i.firstSeen.getTime() === p.at.getTime())
      .map((i) => ({ itemId: i.itemId, status: i.status, ...(i.runId ? { runId: i.runId } : {}), ...(i.message ? { message: i.message } : {}) })),
  }));
}

async function view(db: Db, row: Row, forJob: boolean) {
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
  const { id, agentId, name, kind, enabled, instructions, concurrency, rateCap, config, nextFireAt, overridden } = row;
  return {
    id,
    /** The plugin it is a trigger of, and the fields its owner changed. */
    plugin: row.pluginId ? ((await db.select({ id: plugins.id, name: plugins.name }).from(plugins).where(eq(plugins.id, row.pluginId)))[0] ?? null) : null,
    overridden,
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
    // A poll trigger's latest polls: what each found, and what each new item did.
    lastPolls: row.kind === "poll" ? await pollView(db, row.id, forJob) : [],
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

/** Refuses a change of the Assistant's chat (`agents/builtin.ts`), with its reason. */
async function guard(db: Db | Tx, ownerId: string, agentId: string, change: Extract<AgentChange, { kind: "trigger" }>) {
  const refused = await assistantGuard(db, ownerId, agentId, change);
  if (refused) throw new ORPCError("FORBIDDEN", { message: refused });
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
      // Made as a plugin's element: these are the plugin's values, and a later change of one is an override.
      ...(context.pluginElement ? { pluginId: context.pluginElement.pluginId, pluginComponent: context.pluginElement.component, upstream: { name, instructions, concurrency, rateCap, config } } : {}),
    })
    .returning();
  return view(context.db, row!, !!context.job);
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
      // A write that holds only while a field is as it was read (a Stem decision): checked with the row locked.
      if (context.expectField && !sameValue("trigger", context.expectField.field, (previous as Record<string, unknown>)[context.expectField.field], context.expectField.value)) {
        throw new ORPCError("CONFLICT", { message: "This field changed meanwhile" });
      }
      await guard(tx, context.ownerId, previous.agentId, { kind: "trigger", triggerId: previous.id, enabled: input.enabled, config: input.config });
      const config = input.config ?? previous.config;
      if (config.kind !== previous.kind) throw new ORPCError("BAD_REQUEST", { message: "A trigger's kind can't change" });
      // A primitive or poll trigger can always be turned off, even once what it watches has changed
      // under it: its config is checked when it is turned on again. A schedule's cron is always checked.
      if ((input.enabled ?? previous.enabled) || config.kind === "schedule" || config.kind === "manual") await checkConfig(tx, context.ownerId, await requireAgent(tx, context.ownerId, previous.agentId), config);
      checkInstructions(config, input.instructions ?? previous.instructions);
      const enabled = input.enabled ?? previous.enabled;
      // Items a poll found waiting under the trigger's old source are never told under the new one.
      if (rebaselines(previous, config, enabled)) {
        await tx
          .update(pollItems)
          .set({ status: "refused", message: "The trigger was changed: it reads something else now" })
          .where(and(eq(pollItems.triggerId, previous.id), eq(pollItems.status, "deferred")));
      }
      const [updated] = await tx
        .update(triggersTable)
        .set({
          name: input.name ?? previous.name,
          instructions: input.instructions ?? previous.instructions,
          concurrency: input.concurrency ?? previous.concurrency,
          rateCap: input.rateCap ?? previous.rateCap,
          enabled,
          config,
          // A plugin's trigger: what now differs from the plugin's values is the owner's override; on or off is their setting.
          overridden: overriddenAfter("trigger", previous, { name: input.name, instructions: input.instructions, concurrency: input.concurrency, rateCap: input.rateCap, config: input.config }),
          ...scheduleColumns(config, previous, enabled, now),
          updatedAt: now,
        })
        .where(eq(triggersTable.id, input.id))
        .returning();
      return updated!;
    });
    return view(context.db, row, !!context.job);
  });

const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const row = await find(context.db, context.ownerId, input.id);
  await refuseOwnDelete(context.db, row.pluginId);
  await guard(context.db, context.ownerId, row.agentId, { kind: "trigger", triggerId: row.id, delete: true });
  await context.db.delete(triggersTable).where(eq(triggersTable.id, input.id));
});

const list = owner.input(z.object({ agentId: z.string() })).handler(async ({ input, context }) => {
  await requireAgent(context.db, context.ownerId, input.agentId);
  const rows = await context.db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.agentId, input.agentId), eq(triggersTable.ownerId, context.ownerId)))
    .orderBy(asc(triggersTable.createdAt), asc(triggersTable.id));
  return Promise.all(rows.map((row) => view(context.db, row, !!context.job)));
});

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  return view(context.db, await find(context.db, context.ownerId, input.id), !!context.job);
});

export const triggers = { create, update, delete: remove, list, get };
