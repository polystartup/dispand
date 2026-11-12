import { JOB_SERVER_NAME, storable } from "@dispand/runner-protocol";
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents, agentTools, type CREATED_KINDS, fields, harnesses, plugins, proposals, runners, skillPackages, tables, tools as toolsTable, triggers, type PluginCreated, type ProposalItem } from "../db/schema.ts";
import { assistantGuard, type AgentChange } from "../agents/builtin.ts";
import { newId } from "../ids.ts";
import { canonical } from "./approvals.ts";
import { catalogEntry, defaultUnasked } from "../tools/catalog.ts";
import type { Bundle, TableScope } from "./bundles.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import type { JobIdentity } from "./call.ts";
import type { PlatformTool } from "./tools.ts";

// Proposals: what changes what agents may do is a person's decision. An agent lists the exact
// writes it wants to make (each a configuration write, with its input), asks for them with
// `request_approval`, and may then make exactly those, once each, or have `proposal_apply` make
// them. The owner reads the list from this row, never from the agent's words. A grant runs only
// on such an item; any other listed write may also be made directly, as without a proposal.

/** A proposal is shown whole: no more writes than this, and no more than this as JSON. */
export const MAX_ITEMS = 60;
export const MAX_BYTES = 64 * 1024;
/** A generated plugin's business name, at most this long. */
export const MAX_PLUGIN = 100;

const CLI_PREFIX = `mcp__${JOB_SERVER_NAME}__`;

export const ProposeInput = z.object({
  items: z
    .array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }))
    .describe(
      'The writes to approve, in order: each a tool\'s name (such as tables_create or agents_create) and the exact input you will call it with. Where an id goes, { "$item": n } names what the earlier item n (counted from 0) creates.',
    ),
  plugin: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PLUGIN)
    .optional()
    .describe('The business or use case this setup is for, such as "Acme Law": once applied, what the items create is recorded in the workspace\'s plugin "Generated: <this name>". Give the same name to every proposal of one setup.'),
});

export const ApplyInput = z.object({ proposalId: z.string().describe("The id propose gave you, of a proposal the owner approved") });

/** A Zod error in the words a direct call gives: each problem, at its path. */
export const issues = (error: z.ZodError): string => error.issues.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join("; ");

/** `{ "$item": n }`: what item `n` of the same proposal created. */
type ItemRef = { $item: number };
const isRef = (value: unknown): value is ItemRef => value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "$item");

/** `value` with every reference replaced by `to(n)`: a placeholder when proposed, a created id when used. */
function mapRefs(value: unknown, to: (ref: unknown) => unknown): unknown {
  if (isRef(value)) return to(value);
  if (Array.isArray(value)) return value.map((v) => mapRefs(v, to));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapRefs(v, to)]));
  return value;
}

/** `value` with each of these strings put back as the reference it stood for. */
function restoreRefs(value: unknown, placeholders: Map<string, number>): unknown {
  if (typeof value === "string") return placeholders.has(value) ? { $item: placeholders.get(value)! } : value;
  if (Array.isArray(value)) return value.map((v) => restoreRefs(v, placeholders));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreRefs(v, placeholders)]));
  return value;
}

/**
 * An item's input with its references replaced by what the items they name created; null when
 * one of those wasn't used, or created nothing.
 */
export function resolveRefs(items: ProposalItem[], input: unknown): unknown {
  let missing = false;
  const resolved = mapRefs(input, (ref) => {
    const created = items[(ref as ItemRef).$item]?.createdId;
    if (created === undefined) missing = true;
    return created;
  });
  return missing ? null : resolved;
}

/**
 * `input` parsed by `schema` as `createProposal` parses an item: each `{ "$item": n }` stands for
 * an id while it is parsed, and is kept where it was. The parse's problems otherwise.
 */
export function parseWithRefs(schema: z.ZodType, input: unknown): { data: unknown } | { error: string } {
  const nonce = randomBytes(12).toString("hex");
  const placeholders = new Map<string, number>();
  const substituted = mapRefs(input, (ref) => {
    const placeholder = `${nonce}${String((ref as ItemRef).$item)}`;
    placeholders.set(placeholder, (ref as ItemRef).$item);
    return placeholder;
  });
  const given = schema.safeParse(substituted);
  if (!given.success) return { error: issues(given.error) };
  const kept = restoreRefs(given.data, placeholders);
  if (!everyString(kept, (s) => !s.includes(nonce))) return { error: "a reference stands only where an id goes" };
  return { data: kept };
}

/** Freeze an agent item's effective permissions when it is prepared, on the caller's proposal/setup span. */
export async function snapshotToolPermissions(db: Db, ownerId: string, prior: ProposalItem[], item: ProposalItem): Promise<ProposalItem | string> {
  if (item.tool !== "agents_create" && item.tool !== "agents_update") return item;
  type Ref = string | ItemRef;
  const input = item.input as { id?: Ref; toolIds: Ref[]; toolPermissions?: { toolId: Ref; unasked: string[] }[] };
  const ids = input.toolIds ?? [];
  const given = input.toolPermissions ?? [];
  const key = (id: Ref) => canonical(id);
  if (given.some((p) => !ids.some((id) => key(id) === key(p.toolId)))) return "Each tool permission must name a chosen tool";
  if (new Set(given.map((p) => key(p.toolId))).size !== given.length) return "List each tool's permissions once";
  const direct = ids.filter((id): id is string => typeof id === "string");
  const found = direct.length ? await db.select().from(toolsTable).where(and(inArray(toolsTable.id, direct), eq(toolsTable.ownerId, ownerId))) : [];
  // An update keeps existing grants, including one an earlier item of this setup writes.
  let kept = new Map<string, string[]>();
  if (item.tool === "agents_update") {
    const earlier = prior.findLast((p, i) =>
      (p.tool === "agents_create" && isRef(input.id) && input.id.$item === i) ||
      (p.tool === "agents_update" && canonical((p.input as { id?: Ref }).id) === canonical(input.id)),
    );
    if (earlier) kept = new Map((earlier.toolPermissions ?? []).map((p) => [key(p.toolId), p.unasked]));
    else if (typeof input.id === "string") {
      const rows = await db.select({ toolId: agentTools.toolId, unasked: agentTools.unasked }).from(agentTools).innerJoin(agents, eq(agents.id, agentTools.agentId)).where(and(eq(agents.id, input.id), eq(agents.ownerId, ownerId)));
      kept = new Map(rows.map((p) => [key(p.toolId), p.unasked]));
    }
  }
  const toolPermissions = ids.map((toolId) => {
    let defaults: string[] = [];
    if (typeof toolId === "string") {
      const tool = found.find((t) => t.id === toolId);
      if (tool) defaults = defaultUnasked(tool);
    } else {
      const source = prior[toolId.$item];
      if (source?.tool === "tools_add_from_catalog") defaults = [...(catalogEntry((source.input as { catalogId: string }).catalogId)?.unasked ?? [])];
    }
    return { toolId, unasked: given.find((p) => key(p.toolId) === key(toolId))?.unasked ?? kept.get(key(toolId)) ?? defaults };
  });
  return { ...item, toolPermissions };
}

/** The agent an item would change and how, for the Assistant's guard; null for any other write. */
async function agentChangeOf(db: Db, ownerId: string, tool: string, input: unknown): Promise<[string, AgentChange] | null> {
  // Parsed by the tool's own schema: these keys have these types.
  const { id = "", bundles, dataTables, skillPackageIds, enabled, config } = input as {
    id?: string;
    bundles?: Bundle[];
    dataTables?: TableScope;
    skillPackageIds?: string[];
    enabled?: boolean;
    config?: TriggerConfig;
  };
  if (tool === "agents_update") return [id, { kind: "update", bundles, dataTables, skillPackageIds }];
  if (tool !== "triggers_update" && tool !== "triggers_delete") return null;
  const [trigger] = await db
    .select({ agentId: triggers.agentId })
    .from(triggers)
    .where(and(eq(triggers.id, id), eq(triggers.ownerId, ownerId)));
  if (!trigger) return null;
  return [trigger.agentId, { kind: "trigger", triggerId: id, delete: tool === "triggers_delete", enabled, config }];
}

const everyString = (value: unknown, ok: (s: string) => boolean): boolean =>
  typeof value === "string" ? ok(value) : Array.isArray(value) ? value.every((v) => everyString(v, ok)) : value !== null && typeof value === "object" ? Object.entries(value).every(([k, v]) => ok(k) && everyString(v, ok)) : true;

/** Whether a tool's call may be an item: a configuration write. */
export const proposable = (tool: PlatformTool): boolean => tool.bundle === "configure" && (tool.grant === true || tool.write === true);

/**
 * Stores the writes a Job's agent proposes, as a draft. Each must be a configuration write the
 * Job may use, with an input that tool accepts: it is kept as the tool parsed it, which is what
 * a later call is compared with. A reference to an earlier item is parsed as an id would be and
 * kept as the reference. Refused with the reason when it couldn't be shown whole.
 */
export async function createProposal(db: Db, job: JobIdentity, tools: PlatformTool[], scope: TableScope, input: unknown): Promise<{ proposalId: string } | { error: string }> {
  const parsed = ProposeInput.safeParse(input);
  if (!parsed.success) return { error: `propose needs items, each a tool's name and its input: ${issues(parsed.error)}` };
  if (parsed.data.items.length === 0) return { error: "A proposal lists at least one write" };
  if (parsed.data.items.length > MAX_ITEMS) return { error: `A proposal lists at most ${MAX_ITEMS} writes: make several` };
  // What a reference stands for while its item is parsed: no text an agent could write.
  const nonce = randomBytes(12).toString("hex");
  const items: ProposalItem[] = [];
  for (const [i, item] of parsed.data.items.entries()) {
    const at = `Item ${i + 1} (${item.tool})`;
    // A CLI session sees the Job server's tools as `mcp__job__<name>`: either name is that tool.
    const name = item.tool.startsWith(CLI_PREFIX) ? item.tool.slice(CLI_PREFIX.length) : item.tool;
    const tool = tools.find((t) => t.name === name && proposable(t));
    if (!tool) {
      const writes = tools.filter(proposable).map((t) => t.name);
      return { error: `Item ${i + 1}: ${item.tool} is not a write you can propose. What you can propose: ${writes.join(", ") || "nothing"}.` };
    }
    // Each reference names an earlier item that creates something.
    const placeholders = new Map<string, number>();
    let wrong: string | null = null;
    const substituted = mapRefs(item.input, (ref) => {
      const n = (ref as { $item: unknown }).$item;
      const named = typeof n === "number" ? items[n] : undefined;
      if (Object.keys(ref as object).length !== 1 || !Number.isInteger(n)) wrong ??= `a reference is { "$item": n } alone, n an earlier item's index (from 0)`;
      else if (!named) wrong ??= `{ "$item": ${String(n)} } must name an earlier item: this one is { "$item": ${i} }, the first is { "$item": 0 }`;
      else if (!tools.find((t) => t.name === named.tool)?.creates) wrong ??= `{ "$item": ${String(n)} } names ${named.tool}, which creates nothing to name`;
      const placeholder = `${nonce}${String(n)}`;
      placeholders.set(placeholder, n as number);
      return placeholder;
    });
    if (wrong) return { error: `${at}: ${wrong}` };
    const given = tool.input.safeParse(substituted);
    if (!given.success) return { error: `${at}: ${issues(given.error)}` };
    // Outside the Job's tables, or naming nothing: as for any call, and before a person is asked
    // about it. A table an earlier item creates is outside a Job limited to some tables.
    const touched = await tool.tables(db, job.ownerId, given.data);
    if (touched.some((id) => id === null || (scope !== "all" && !scope.includes(id)))) return { error: `${at}: Not found` };
    // What the Assistant can't lose is refused now, with the reason, not after a person approved it.
    const change = await agentChangeOf(db, job.ownerId, tool.name, given.data);
    const refused = change && (await assistantGuard(db, job.ownerId, change[0], change[1]));
    if (refused) return { error: `${at}: ${refused}` };
    const kept = restoreRefs(given.data, placeholders);
    // A reference stands only where its text was kept whole: an id, not inside another text.
    if (!everyString(kept, (s) => !s.includes(nonce))) return { error: `${at}: a reference stands only where an id goes` };
    const prepared = await snapshotToolPermissions(db, job.ownerId, items, { tool: tool.name, input: kept });
    if (typeof prepared === "string") return { error: `${at}: ${prepared}` };
    items.push(prepared);
  }
  if (!everyString([items, parsed.data.plugin ?? ""], storable)) return { error: "The proposal holds a character Dispand can't store (NUL or a lone surrogate)" };
  if (Buffer.byteLength(JSON.stringify(items)) > MAX_BYTES) return { error: "The proposal is too large to show whole (at most 64 KiB): make several, or shorten the texts" };
  const id = newId("prop");
  await db.insert(proposals).values({ id, ownerId: job.ownerId, runId: job.runId, agentId: job.agentId, items, plugin: parsed.data.plugin ?? null });
  return { proposalId: id };
}

/** An item of a proposal, by its index. */
export type ItemAt = { proposalId: string; index: number; toolPermissions?: { toolId: string; unasked: string[] }[] };

/**
 * Uses up one approved write of the Job: an item of one of its approved proposals (or the one
 * `at` names), for that tool, with the same input (key order aside, references read as what
 * their items created), not used yet. One row lock per proposal, so of two calls that match the
 * same item one takes it. Used, the item stays used whatever its call does next.
 */
export async function takeItem(db: Db, job: JobIdentity, tool: string, input: unknown, at?: ItemAt): Promise<ItemAt | null> {
  const wanted = canonical(input);
  return db.transaction(async (tx) => {
    const approved = await tx
      .select({ id: proposals.id, items: proposals.items })
      .from(proposals)
      .where(
        and(
          eq(proposals.runId, job.runId),
          eq(proposals.ownerId, job.ownerId),
          eq(proposals.agentId, job.agentId),
          eq(proposals.status, "approved"),
          ...(at ? [eq(proposals.id, at.proposalId)] : []),
        ),
      )
      .orderBy(asc(proposals.createdAt), asc(proposals.id))
      .for("update");
    for (const proposal of approved) {
      const index = proposal.items.findIndex(
        (item, i) => (at === undefined || i === at.index) && item.usedAt === undefined && item.tool === tool &&
          // Old unconsumed agent grants did not record what runs unasked: propose those again.
          (!(tool === "agents_create" || tool === "agents_update") || !(item.input as { toolIds?: unknown[] })?.toolIds?.length || item.toolPermissions !== undefined) &&
          canonical(resolveRefs(proposal.items, item.input)) === wanted,
      );
      if (index < 0) continue;
      // Pending until its call ends (`recordOutcome`): an apply doesn't go past it meanwhile.
      const items = proposal.items.map((item, i) => (i === index ? { ...item, usedAt: new Date().toISOString(), pending: true as const } : item));
      await tx.update(proposals).set({ items }).where(eq(proposals.id, proposal.id));
      const permissions = proposal.items[index]!.toolPermissions;
      return { proposalId: proposal.id, index, ...(permissions ? { toolPermissions: resolveRefs(proposal.items, permissions) as ItemAt["toolPermissions"] } : {}) };
    }
    return null;
  });
}

/** Records how a used item's call ended: made (with what it created, for the items that name it), or failed. */
export async function recordOutcome(db: Db, at: ItemAt, outcome: { createdId?: string } | { failed: true }): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ items: proposals.items }).from(proposals).where(eq(proposals.id, at.proposalId)).for("update");
    if (!row) return;
    const items = row.items.map((item, i) => {
      if (i !== at.index) return item;
      const ended = { ...item, ...outcome };
      delete ended.pending;
      return ended;
    });
    await tx.update(proposals).set({ items }).where(eq(proposals.id, at.proposalId));
  });
}

/** A proposal of the Job's, for `proposal_apply`: its items when approved, or why not. */
export async function approvedItems(db: Db, job: JobIdentity, proposalId: string): Promise<ProposalItem[] | string> {
  const [row] = await db
    .select({ status: proposals.status, items: proposals.items })
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.runId, job.runId), eq(proposals.ownerId, job.ownerId), eq(proposals.agentId, job.agentId)));
  if (!row) return "No proposal of this Job has this id";
  if (row.status === "draft") return "This proposal wasn't asked for yet: call request_approval with its id";
  if (row.status === "asked") return "This proposal waits for the owner's answer";
  if (row.status === "declined") return "The owner declined this proposal: propose again with what they asked for";
  return row.items;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The name a generated plugin goes by. */
export const generatedName = (business: string): string => `Generated: ${business}`;

/**
 * Records in the generated plugin a proposal names what its items created (through
 * `proposal_apply` or a direct call), creating the plugin on first use. Ids are only added: the
 * plugin lists, it never owns, so nothing references it. Null when the proposal names no plugin
 * or nothing was created yet.
 */
export async function recordInPlugin(db: Db, ownerId: string, proposalId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ items: proposals.items, plugin: proposals.plugin })
      .from(proposals)
      .where(and(eq(proposals.id, proposalId), eq(proposals.ownerId, ownerId)));
    if (!row?.plugin) return null;
    const made = row.items.flatMap((item) => {
      const kind = createsOf(item.tool);
      return kind && item.createdId ? [[kind, item.createdId] as const] : [];
    });
    if (made.length === 0) return null;
    const name = generatedName(row.plugin);
    // One per name (`plugins_owner_generated_idx`): of two applies at once, one inserts it.
    await tx
      .insert(plugins)
      .values({ id: newId("plugin"), ownerId, name, description: `What approved proposals created for ${row.plugin}`, source: "generated", components: { skills: [], mcpServers: [], agents: [] } })
      .onConflictDoNothing();
    const [plugin] = await tx
      .select({ id: plugins.id, created: plugins.created })
      .from(plugins)
      .where(and(eq(plugins.ownerId, ownerId), eq(plugins.source, "generated"), eq(plugins.name, name)))
      .for("update");
    // Removed by the owner since the insert: the next item made creates it again.
    if (!plugin) return null;
    for (const [kind, id] of made) await recordCreated(tx, plugin.id, kind, id);
    return plugin.id;
  });
}

/**
 * Lists `id` in a plugin's `created`, under its kind, and under `from` (a definition's key) when
 * it was made from one: a resumed setup finds it there, by id. Ids are only added.
 */
export async function recordCreated(db: Db | Tx, pluginId: string, kind: (typeof CREATED_KINDS)[number], id: string, from?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [plugin] = await tx.select({ created: plugins.created }).from(plugins).where(eq(plugins.id, pluginId)).for("update");
    // Removed meanwhile: nothing lists what was made.
    if (!plugin) return;
    const created: PluginCreated = { ...plugin.created, [kind]: [...new Set([...(plugin.created[kind] ?? []), id])] };
    if (from) created.from = { ...plugin.created.from, [from]: id };
    await tx.update(plugins).set({ created, updatedAt: sql`now()` }).where(eq(plugins.id, pluginId));
  });
}

/**
 * A `request_approval` that names a proposal: the draft of that run becomes the one this
 * question asks for. One conditional update, so a proposal has one question, whatever asks
 * for it twice. Null when the id names no draft of the run: the request is then words only.
 */
export async function attachProposal(db: Db | Tx, run: { runId: string; ownerId: string }, questionId: string, input: unknown): Promise<string | null> {
  const id = (input as { proposal?: unknown } | null)?.proposal;
  if (typeof id !== "string") return null;
  const [row] = await db
    .update(proposals)
    .set({ status: "asked", questionId })
    .where(and(eq(proposals.id, id), eq(proposals.runId, run.runId), eq(proposals.ownerId, run.ownerId), eq(proposals.status, "draft")))
    .returning({ id: proposals.id });
  return row?.id ?? null;
}

/** The owner's answer to the question a proposal was asked with: approved or declined, once. */
export async function settleProposal(db: Db | Tx, questionId: string, approved: boolean): Promise<void> {
  await db
    .update(proposals)
    .set({ status: approved ? "approved" : "declined", settledAt: new Date() })
    .where(and(eq(proposals.questionId, questionId), eq(proposals.status, "asked")));
}

export type ProposalName = { kind: "agent" | "harness" | "tool" | "skill" | "table" | "field" | "trigger" | "catalog"; name: string; detail?: string };

/**
 * For each tool that can be proposed: the keys of its input that hold ids, and of what. Only
 * these are read as names; any other value is shown as data.
 */
const REFS: Record<string, Record<string, ProposalName["kind"]>> = {
  agents_create: { harnessId: "harness", toolIds: "tool", skillPackageIds: "skill", dataTables: "table" },
  agents_update: { id: "agent", harnessId: "harness", toolIds: "tool", skillPackageIds: "skill", dataTables: "table" },
  agents_set_tool_ask: { agentId: "agent", toolId: "tool" },
  harnesses_set_limit: { id: "harness" },
  tables_rename: { id: "table" },
  tables_set_primitive: { id: "table" },
  tables_delete: { id: "table" },
  fields_create: { tableId: "table", referencesTableId: "table" },
  fields_update: { id: "field" },
  fields_reorder: { tableId: "table", fieldIds: "field" },
  fields_delete: { id: "field" },
  triggers_create: { agentId: "agent" },
  triggers_update: { id: "trigger" },
  triggers_delete: { id: "trigger" },
  tools_delete: { id: "tool" },
  tools_add_from_catalog: { catalogId: "catalog" },
};

/** What each creating tool creates (its output's `id`): what `{ "$item": n }` may name, and how a reference reads: "the table item 2 creates". */
export const CREATES: Record<string, (typeof CREATED_KINDS)[number]> = {
  tables_create: "table",
  fields_create: "field",
  agents_create: "agent",
  triggers_create: "trigger",
  tools_add: "tool",
  tools_add_from_catalog: "tool",
};
const createsOf = (tool: string): (typeof CREATED_KINDS)[number] | undefined => CREATES[tool];

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : []);

/**
 * A proposal as its owner reads it: every item whole, with the keys of its input that are ids
 * (`refs`), and a name for each of those ids as they are now. An id with no name here names
 * nothing of the owner's: the Inbox says so.
 */
export async function proposalView(db: Db, ownerId: string, proposalId: string) {
  const [row] = await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.ownerId, ownerId)));
  if (!row) return null;
  return { id: row.id, status: row.status, plugin: row.plugin ? generatedName(row.plugin) : null, ...(await itemsView(db, ownerId, row.items)) };
}

/** Items as their owner reads them, as in a proposal (`proposalView`): a plugin's setup shows its own so. */
export async function itemsView(db: Db, ownerId: string, items: ProposalItem[]) {
  const wanted = new Map<ProposalName["kind"], Set<string>>();
  for (const item of items) {
    for (const [key, kind] of Object.entries(REFS[item.tool] ?? {})) {
      const ids = strings(((item.input ?? {}) as Record<string, unknown>)[key]).filter((id) => !(key === "dataTables" && id === "all"));
      if (!wanted.has(kind)) wanted.set(kind, new Set());
      for (const id of ids) wanted.get(kind)!.add(id);
    }
    // An agent's consult entries name the agents it may consult.
    const consults = ((item.input ?? {}) as { consults?: unknown }).consults;
    if (item.tool.startsWith("agents_") && Array.isArray(consults)) {
      if (!wanted.has("agent")) wanted.set("agent", new Set());
      for (const entry of consults) for (const id of strings((entry as { agentId?: unknown } | null)?.agentId)) wanted.get("agent")!.add(id);
    }
    // A primitive table's parent is a table too.
    const parent = ((item.input ?? {}) as { parent?: { tableId?: unknown } | null }).parent;
    if (item.tool === "tables_set_primitive" && parent) {
      if (!wanted.has("table")) wanted.set("table", new Set());
      for (const id of strings(parent.tableId)) wanted.get("table")!.add(id);
    }
    // What a used item created, named as it is now.
    const kind = createsOf(item.tool);
    if (kind && item.createdId) {
      if (!wanted.has(kind)) wanted.set(kind, new Set());
      wanted.get(kind)!.add(item.createdId);
    }
    // A table-change trigger names its table and fields inside its config.
    const config = ((item.input ?? {}) as { config?: { kind?: unknown; tableId?: unknown; fields?: unknown } }).config;
    if (item.tool.startsWith("triggers_") && config?.kind === "primitive") {
      for (const [kind, ids] of [["table", strings(config.tableId)], ["field", strings(config.fields)]] as const) {
        if (!wanted.has(kind)) wanted.set(kind, new Set());
        for (const id of ids) wanted.get(kind)!.add(id);
      }
    }
  }
  const names: Record<string, ProposalName> = {};
  // A catalog entry, by its name and where its tool's calls go.
  for (const id of wanted.get("catalog") ?? []) {
    const entry = catalogEntry(id);
    if (entry) names[id] = { kind: "catalog", name: entry.name, detail: entry.kind === "http" ? entry.url : "on a runner" };
  }
  const found = async <T extends { id: string }>(kind: ProposalName["kind"], load: (ids: string[]) => Promise<T[]>, name: (row: T) => Omit<ProposalName, "kind">) => {
    const ids = [...(wanted.get(kind) ?? [])];
    for (const r of ids.length ? await load(ids) : []) names[r.id] = { kind, ...name(r) };
  };
  await found(
    "agent",
    (w) => db.select({ id: agents.id, name: agents.name }).from(agents).where(and(inArray(agents.id, w), eq(agents.ownerId, ownerId))),
    (r) => ({ name: r.name }),
  );
  await found(
    "harness",
    (w) =>
      db
        .select({ id: harnesses.id, name: harnesses.name, kind: harnesses.kind, permissionMode: harnesses.permissionMode, runner: runners.name })
        .from(harnesses)
        .leftJoin(runners, eq(runners.id, harnesses.runnerId))
        .where(and(inArray(harnesses.id, w), eq(harnesses.ownerId, ownerId))),
    (r) => ({ name: r.name, detail: [r.kind, r.runner ? `on ${r.runner}` : null, r.permissionMode ? `permission mode ${r.permissionMode}` : null].filter(Boolean).join(", ") }),
  );
  await found(
    "tool",
    (w) => db.select({ id: toolsTable.id, name: toolsTable.name, kind: toolsTable.kind, url: toolsTable.url }).from(toolsTable).where(and(inArray(toolsTable.id, w), eq(toolsTable.ownerId, ownerId))),
    (r) => ({ name: r.name, detail: r.kind === "http" ? (r.url ?? "") : "on a runner" }),
  );
  await found(
    "skill",
    (w) => db.select({ id: skillPackages.id, name: skillPackages.name }).from(skillPackages).where(and(inArray(skillPackages.id, w), eq(skillPackages.ownerId, ownerId))),
    (r) => ({ name: r.name }),
  );
  await found(
    "table",
    (w) => db.select({ id: tables.id, name: tables.name }).from(tables).where(and(inArray(tables.id, w), eq(tables.ownerId, ownerId))),
    (r) => ({ name: r.name }),
  );
  await found(
    "field",
    (w) =>
      db
        .select({ id: fields.id, name: fields.name, table: tables.name })
        .from(fields)
        .innerJoin(tables, eq(tables.id, fields.tableId))
        .where(and(inArray(fields.id, w), eq(fields.ownerId, ownerId))),
    (r) => ({ name: r.name, detail: `of the table ${r.table}` }),
  );
  await found(
    "trigger",
    (w) =>
      db
        .select({ id: triggers.id, name: triggers.name, agent: agents.name })
        .from(triggers)
        .innerJoin(agents, eq(agents.id, triggers.agentId))
        .where(and(inArray(triggers.id, w), eq(triggers.ownerId, ownerId))),
    (r) => ({ name: r.name, detail: `of the agent ${r.agent}` }),
  );
  return {
    items: items.map(({ tool, input, usedAt, createdId, failed, toolPermissions }) => ({
      tool,
      input,
      used: usedAt !== undefined,
      failed: failed === true,
      refs: Object.keys(REFS[tool] ?? {}),
      creates: createsOf(tool) ?? null,
      createdId: createdId ?? null,
      ...(toolPermissions ? { tools: toolPermissions.map((p) => ({ toolId: p.toolId, runs: p.unasked })) } : {}),
    })),
    names,
  };
}
