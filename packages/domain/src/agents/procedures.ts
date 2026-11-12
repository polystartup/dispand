import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents as agentsTable, agentSkills, agentTools, harnesses, plugins, skillPackages, tables as tablesTable, tools as toolsTable } from "../db/schema.ts";
import { lockAgentsForDelete } from "../jobs/active.ts";
import { MEMORY_TARGETS } from "../memory/model.ts";
import { BUNDLES, type TableScope } from "../platform/bundles.ts";
import { ModelName } from "../harnesses/procedures.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { defaultUnasked } from "../tools/catalog.ts";
import { StorableText } from "../workflows/model.ts";
import { agentInUse } from "../workflows/procedures.ts";
import { assistantGuard, ensureAssistant, findAssistant } from "./builtin.ts";
import { consultsOf, pairProblem, setConsults, type ConsultEntry } from "./consults.ts";
import { lockConsults } from "../engine/consults.ts";
import { skillsAndTools } from "./skills-and-tools.ts";
import { setAsk } from "./tool-ask.ts";
import { effectiveTools } from "./tools.ts";

const owner = base.use(authed);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const Ids = z
  .array(z.string().max(64))
  .max(50)
  .default([])
  .transform((ids) => [...new Set(ids)]);

/** The agents it may consult, each at most once (the last one given wins). */
const Consults = z
  .array(z.object({ agentId: z.string().max(64), ask: z.boolean() }))
  .max(50)
  .transform((entries) => [...new Map(entries.map((e) => [e.agentId, e])).values()]);

const Fields = z.object({
  name: StorableText(100).trim().min(1),
  /** What it is for and when to consult it; left out of an update, it stays as it is. */
  description: StorableText(2000).optional(),
  harnessId: z.string(),
  systemPrompt: StorableText(100_000),
  /** Overrides the harness's model; absent, the harness's (or the CLI's default) is used. */
  model: ModelName.optional(),
  /** The agent's skill packages; each brings the tools it requires, locked. */
  skillPackageIds: Ids,
  /** Tools chosen for the agent itself, besides the ones its packages require. */
  toolIds: Ids,
  /** What its Jobs may do through Dispand's own tools; left out of an update, they stay as they are. */
  bundles: z
    .array(z.enum(BUNDLES))
    .max(BUNDLES.length)
    .transform((b) => [...new Set(b)])
    .optional(),
  /** Where its Jobs may write memory; left out of an update, they stay as they are. Setting it is a grant. */
  selfLearning: z
    .array(z.enum(MEMORY_TARGETS))
    .max(MEMORY_TARGETS.length)
    .transform((t) => [...new Set(t)])
    .optional(),
  /** The tables its Jobs may work on: all, or these. */
  dataTables: z.union([z.literal("all"), z.array(z.string().max(64)).max(100)]).optional(),
  /** The agents its Jobs may consult; left out of an update, they stay as they are. */
  consults: Consults.optional(),
});

/**
 * The list with only the owner's own tables, in the order given: an id that names none (a table
 * deleted since, or someone else's) is left out, never granted and never an error, so an agent
 * whose list outlived a table can still be saved.
 */
async function ownTables(db: Db, ownerId: string, scope: TableScope | undefined): Promise<TableScope | undefined> {
  if (scope === undefined || scope === "all" || scope.length === 0) return scope;
  const found = await db
    .select({ id: tablesTable.id })
    .from(tablesTable)
    .where(and(inArray(tablesTable.id, scope), eq(tablesTable.ownerId, ownerId)));
  return [...new Set(scope)].filter((id) => found.some((t) => t.id === id));
}

function toAgent(row: typeof agentsTable.$inferSelect) {
  const { id, ownerId, name, description, harnessId, systemPrompt, model, bundles, dataTables, selfLearning, builtIn } = row;
  return { id, ownerId, name, description, harnessId, systemPrompt, ...(model === null ? {} : { model }), bundles, dataTables, selfLearning, ...(builtIn === null ? {} : { builtIn }) };
}

type Row = typeof agentsTable.$inferSelect;

/** The agents with the plugin each came from (`null` for the owner's own). */
async function withPlugins(db: Db, rows: Row[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.pluginId ? [r.pluginId] : [])))];
  const found = ids.length ? await db.select({ id: plugins.id, name: plugins.name }).from(plugins).where(inArray(plugins.id, ids)) : [];
  return rows.map((r) => ({ ...toAgent(r), plugin: found.find((p) => p.id === r.pluginId) ?? null }));
}

/** Refuses a change the Assistant can't take (`builtin.ts`), with its reason. */
async function guard(db: Db, ownerId: string, agentId: string, change: Parameters<typeof assistantGuard>[3]) {
  const refused = await assistantGuard(db, ownerId, agentId, change);
  if (refused) throw new ORPCError("FORBIDDEN", { message: refused });
}

/** The harness, with the runner it runs on (none for a cloud harness). */
async function requireHarness(db: Db, ownerId: string, harnessId: string): Promise<{ runnerId: string | null }> {
  const [row] = await db
    .select({ id: harnesses.id, runnerId: harnesses.runnerId })
    .from(harnesses)
    .where(and(eq(harnesses.id, harnessId), eq(harnesses.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Harness not found" });
  return row;
}

async function find(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, id), eq(agentsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

/**
 * Replaces the agent's skill packages and explicit tools. Each id must be the owner's; the rows
 * are locked (shared) so a package or tool can't be deleted while it is being attached. Every
 * runner tool it gets, a skill's required ones included, must run on the harness's runner.
 */
async function attach(tx: Tx, ownerId: string, agentId: string, packageIds: string[], toolIds: string[], harnessRunnerId: string | null) {
  const pkgs = packageIds.length
    ? await tx
        .select({ id: skillPackages.id, name: skillPackages.name, requiredToolIds: skillPackages.requiredToolIds })
        .from(skillPackages)
        .where(and(inArray(skillPackages.id, packageIds), eq(skillPackages.ownerId, ownerId)))
        .for("share")
    : [];
  if (pkgs.length !== packageIds.length) throw new ORPCError("NOT_FOUND", { message: "Skill not found" });
  const found = toolIds.length
    ? await tx
        .select({ id: toolsTable.id, actions: toolsTable.actions, catalogId: toolsTable.catalogId })
        .from(toolsTable)
        .where(and(inArray(toolsTable.id, toolIds), eq(toolsTable.ownerId, ownerId)))
        .for("share")
    : [];
  if (found.length !== toolIds.length) throw new ORPCError("NOT_FOUND", { message: "Tool not found" });
  const effective = effectiveTools(toolIds, pkgs).map((t) => t.toolId);
  const runnerTools = effective.length
    ? await tx
        .select({ name: toolsTable.name, runnerId: toolsTable.runnerId })
        .from(toolsTable)
        .where(and(inArray(toolsTable.id, effective), eq(toolsTable.ownerId, ownerId), eq(toolsTable.kind, "runner")))
        .orderBy(asc(toolsTable.name))
    : [];
  for (const tool of runnerTools) {
    if (harnessRunnerId === null) throw new ORPCError("BAD_REQUEST", { message: `Runner tools only work with CLI harnesses: “${tool.name}” runs on a runner` });
    if (tool.runnerId !== harnessRunnerId) throw new ORPCError("BAD_REQUEST", { message: `The tool “${tool.name}” runs on another runner than the agent's harness` });
  }
  await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
  // A tool the agent keeps keeps its unasked actions; one added now starts with its catalog
  // entry's, or the actions its server calls read-only. Only here are those read: later, they change nothing by themselves.
  const kept = new Map((await tx.delete(agentTools).where(eq(agentTools.agentId, agentId)).returning()).map((t) => [t.toolId, t.unasked]));
  if (packageIds.length) await tx.insert(agentSkills).values(packageIds.map((packageId) => ({ agentId, packageId })));
  if (toolIds.length) {
    await tx.insert(agentTools).values(
      toolIds.map((toolId) => ({
        agentId,
        toolId,
        unasked: kept.get(toolId) ?? defaultUnasked(found.find((t) => t.id === toolId)!),
      })),
    );
  }
}

/** Makes these the agents it may consult, refused with the reason a new entry can't be made. */
async function consults(tx: Tx, ownerId: string, agentId: string, entries: ConsultEntry[] | undefined) {
  if (entries === undefined) return;
  const problem = await setConsults(tx, ownerId, agentId, entries);
  if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
}

/**
 * The agent with its skill packages, the tools it gets (explicit ones, and the ones its packages
 * require, locked) and the agents it may consult, each with why it is inactive when a bundle
 * change put the pair on two sides of `configure` since it was made.
 */
async function withSkillsAndTools(db: Db, row: Row) {
  const [agent] = await withPlugins(db, [row]);
  const entries = await consultsOf(db, row.id);
  return {
    ...agent!,
    ...(await skillsAndTools(db, row.id)),
    consults: await Promise.all(entries.map(async (e) => ({ ...e, inactive: await pairProblem(db, row.ownerId, row.id, e.agentId) }))),
  };
}

const create = owner.input(Fields).handler(async ({ input, context }) => {
  const { skillPackageIds, toolIds, bundles, selfLearning, consults: entries, ...fields } = input;
  const harness = await requireHarness(context.db, context.ownerId, fields.harnessId);
  const dataTables = await ownTables(context.db, context.ownerId, input.dataTables);
  const row = await context.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agentsTable)
      .values({ ...fields, model: fields.model ?? null, bundles: bundles ?? [], selfLearning: selfLearning ?? [], dataTables: dataTables ?? "all", id: newId("agent"), ownerId: context.ownerId })
      .returning();
    await attach(tx, context.ownerId, row!.id, skillPackageIds, toolIds, harness.runnerId);
    await consults(tx, context.ownerId, row!.id, entries);
    return row!;
  });
  return (await withPlugins(context.db, [row]))[0]!;
});

const update = owner.input(Fields.extend({ id: z.string() })).handler(async ({ input, context }) => {
  const { id, skillPackageIds, toolIds, bundles, selfLearning, consults: entries, ...fields } = input;
  await find(context.db, context.ownerId, id);
  const harness = await requireHarness(context.db, context.ownerId, fields.harnessId);
  const dataTables = await ownTables(context.db, context.ownerId, input.dataTables);
  await guard(context.db, context.ownerId, id, { kind: "update", bundles, dataTables, skillPackageIds });
  const { row, ended } = await context.db.transaction(async (tx) => {
    // First: a consult opened meanwhile is either seen by `endConsults` or sees this change.
    await lockConsults(tx, context.ownerId);
    const [row] = await tx
      .update(agentsTable)
      .set({ ...fields, model: fields.model ?? null, ...(bundles ? { bundles } : {}), ...(selfLearning ? { selfLearning } : {}), ...(dataTables ? { dataTables } : {}) })
      .where(and(eq(agentsTable.id, id), eq(agentsTable.ownerId, context.ownerId)))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND");
    await attach(tx, context.ownerId, id, skillPackageIds, toolIds, harness.runnerId);
    await consults(tx, context.ownerId, id, entries);
    // A right taken back (an entry removed, a flag added, a bundle change across `configure`) ends the consults in flight on it, at once.
    return { row, ended: await context.engine.endConsults(tx, context.ownerId, [id]) };
  });
  context.engine.settled(ended);
  return (await withPlugins(context.db, [row]))[0]!;
});

const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const [agent] = await withPlugins(context.db, [await find(context.db, context.ownerId, input.id)]);
  await guard(context.db, context.ownerId, input.id, { kind: "delete" });
  // A plugin's agent goes with its plugin.
  if (agent!.plugin) throw new ORPCError("FORBIDDEN", { message: `Remove the plugin ${agent!.plugin.name} instead` });
  if (await agentInUse(context.db, context.ownerId, input.id)) {
    throw new ORPCError("CONFLICT", { message: "A workflow uses this agent" });
  }
  await context.db.transaction(async (tx) => {
    if (await lockAgentsForDelete(tx, [input.id])) throw new ORPCError("CONFLICT", { message: "A Job of this agent is still going" });
    // Its triggers and its finished Jobs go with it.
    await tx.delete(agentsTable).where(eq(agentsTable.id, input.id));
  });
});

const list = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.ownerId, context.ownerId))
    .orderBy(asc(agentsTable.createdAt), asc(agentsTable.id));
  return withPlugins(context.db, rows);
});

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  return withSkillsAndTools(context.db, await find(context.db, context.ownerId, input.id));
});

/**
 * The actions of each tool reached by URL the agent chose, with whether each asks the owner
 * before use. A tool that only comes with a skill isn't here (all its actions ask), nor a
 * runner's own tool (its CLI asks for each call).
 */
const toolAsk = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const agent = await find(context.db, context.ownerId, input.id);
  const rows = await context.db
    .select({ toolId: toolsTable.id, name: toolsTable.name, actions: toolsTable.actions, unasked: agentTools.unasked })
    .from(agentTools)
    .innerJoin(toolsTable, eq(toolsTable.id, agentTools.toolId))
    .where(and(eq(agentTools.agentId, agent.id), eq(toolsTable.ownerId, context.ownerId), eq(toolsTable.kind, "http")))
    .orderBy(asc(toolsTable.name));
  return rows.map(({ toolId, name, actions, unasked }) => ({
    toolId,
    name,
    actions: actions.map((a) => ({ name: a.name, description: a.description, readOnly: a.readOnly === true, ask: !unasked.includes(a.name) })),
  }));
});

/**
 * Makes one action of an agent's tool ask before use, or run without asking. Taking the question
 * away is a grant: a person does it, here. No Job reaches this procedure (it is not a platform tool).
 */
const setToolAsk = owner.input(z.object({ agentId: z.string(), toolId: z.string(), action: z.string(), ask: z.boolean() })).handler(async ({ input, context }) => {
  if (!(await setAsk(context.db, context.ownerId, input))) throw new ORPCError("NOT_FOUND");
  return { ok: true as const };
});

/** The workspace's Assistant and its chat trigger, or null when the owner has none yet. */
const assistant = owner.handler(({ context }) => findAssistant(context.db, context.ownerId));

/** Makes the owner's Assistant on this harness, or gives the one there is (left on its own harness). */
const ensure = owner.input(z.object({ harnessId: z.string() })).handler(async ({ input, context }) => {
  await requireHarness(context.db, context.ownerId, input.harnessId);
  return ensureAssistant(context.db, context.ownerId, input.harnessId);
});

export const agents = { create, update, delete: remove, list, get, toolAsk, setToolAsk, assistant, ensureAssistant: ensure };
