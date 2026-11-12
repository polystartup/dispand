import { JOB_SERVER_NAME, storable } from "@dispand/runner-protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents, fields, harnesses, proposals, runners, skillPackages, tables, tools as toolsTable, triggers, type ProposalItem } from "../db/schema.ts";
import { assistantGuard, type AgentChange } from "../agents/builtin.ts";
import { newId } from "../ids.ts";
import { canonical } from "./approvals.ts";
import type { Bundle, TableScope } from "./bundles.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import type { JobIdentity } from "./call.ts";
import type { PlatformTool } from "./tools.ts";

// Proposals: what changes what agents may do is a person's decision. An agent lists the exact
// writes it wants to make (each a tool marked `grant`, with its input), asks for them with
// `request_approval`, and may then make exactly those, once each. The owner reads the list from
// this row, never from the agent's words.

/** A proposal is shown whole: no more writes than this, and no more than this as JSON. */
export const MAX_ITEMS = 20;
export const MAX_BYTES = 64 * 1024;

const CLI_PREFIX = `mcp__${JOB_SERVER_NAME}__`;

export const ProposeInput = z.object({
  items: z
    .array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }))
    .describe("The writes to approve: each a tool's name (such as agents_create) and the exact input you will call it with"),
});

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

/**
 * Stores the writes a Job's agent proposes, as a draft. Each must be a grant tool the Job may
 * use, with an input that tool accepts: it is kept as the tool parsed it, which is what a later
 * call is compared with. Refused with the reason when it couldn't be shown whole.
 */
export async function createProposal(db: Db, job: JobIdentity, tools: PlatformTool[], scope: TableScope, input: unknown): Promise<{ proposalId: string } | { error: string }> {
  const parsed = ProposeInput.safeParse(input);
  if (!parsed.success) return { error: "propose needs items: each a tool's name and its input" };
  if (parsed.data.items.length === 0) return { error: "A proposal lists at least one write" };
  if (parsed.data.items.length > MAX_ITEMS) return { error: `A proposal lists at most ${MAX_ITEMS} writes: make several` };
  const items: ProposalItem[] = [];
  for (const [i, item] of parsed.data.items.entries()) {
    // A CLI session sees the Job server's tools as `mcp__job__<name>`: either name is that tool.
    const name = item.tool.startsWith(CLI_PREFIX) ? item.tool.slice(CLI_PREFIX.length) : item.tool;
    const tool = tools.find((t) => t.name === name && t.grant);
    if (!tool) {
      const proposable = tools.filter((t) => t.grant).map((t) => t.name);
      return { error: `Item ${i + 1}: ${item.tool} is not a write you can propose. What you can propose: ${proposable.join(", ") || "nothing"}. Other tools are called directly.` };
    }
    const given = tool.input.safeParse(item.input);
    if (!given.success) return { error: `Item ${i + 1} (${item.tool}): ${given.error.issues.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join("; ")}` };
    // Outside the Job's tables, or naming nothing: as for any call, and before a person is asked about it.
    const touched = await tool.tables(db, job.ownerId, given.data);
    if (touched.some((id) => id === null || (scope !== "all" && !scope.includes(id)))) return { error: `Item ${i + 1} (${tool.name}): Not found` };
    // What the Assistant can't lose is refused now, with the reason, not after a person approved it.
    const change = await agentChangeOf(db, job.ownerId, tool.name, given.data);
    const refused = change && (await assistantGuard(db, job.ownerId, change[0], change[1]));
    if (refused) return { error: `Item ${i + 1} (${tool.name}): ${refused}` };
    items.push({ tool: tool.name, input: given.data });
  }
  if (!everyString(items, storable)) return { error: "The proposal holds a character Dispand can't store (NUL or a lone surrogate)" };
  if (Buffer.byteLength(JSON.stringify(items)) > MAX_BYTES) return { error: "The proposal is too large to show whole (at most 64 KiB): make several, or shorten the texts" };
  const id = newId("prop");
  await db.insert(proposals).values({ id, ownerId: job.ownerId, runId: job.runId, agentId: job.agentId, items });
  return { proposalId: id };
}

/**
 * Uses up one approved write of the Job: an item of one of its approved proposals, for that
 * tool, with the same input (key order aside), not used yet. One row lock per proposal, so of
 * two calls that match the same item one takes it.
 */
export async function takeItem(db: Db, job: JobIdentity, tool: string, input: unknown): Promise<boolean> {
  const wanted = canonical(input);
  return db.transaction(async (tx) => {
    const approved = await tx
      .select({ id: proposals.id, items: proposals.items })
      .from(proposals)
      .where(and(eq(proposals.runId, job.runId), eq(proposals.ownerId, job.ownerId), eq(proposals.agentId, job.agentId), eq(proposals.status, "approved")))
      .orderBy(asc(proposals.createdAt), asc(proposals.id))
      .for("update");
    for (const proposal of approved) {
      const at = proposal.items.findIndex((item) => item.usedAt === undefined && item.tool === tool && canonical(item.input) === wanted);
      if (at < 0) continue;
      const items = proposal.items.map((item, i) => (i === at ? { ...item, usedAt: new Date().toISOString() } : item));
      await tx.update(proposals).set({ items }).where(eq(proposals.id, proposal.id));
      return true;
    }
    return false;
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

export type ProposalName = { kind: "agent" | "harness" | "tool" | "skill" | "table" | "field" | "trigger"; name: string; detail?: string };

/**
 * For each tool that can be proposed: the keys of its input that hold ids, and of what. Only
 * these are read as names; any other value is shown as data.
 */
const REFS: Record<string, Record<string, ProposalName["kind"]>> = {
  agents_create: { harnessId: "harness", toolIds: "tool", skillPackageIds: "skill", dataTables: "table" },
  agents_update: { id: "agent", harnessId: "harness", toolIds: "tool", skillPackageIds: "skill", dataTables: "table" },
  agents_set_tool_ask: { agentId: "agent", toolId: "tool" },
  harnesses_set_limit: { id: "harness" },
  tables_delete: { id: "table" },
  fields_delete: { id: "field" },
  triggers_create: { agentId: "agent" },
  triggers_update: { id: "trigger" },
  triggers_delete: { id: "trigger" },
  tools_delete: { id: "tool" },
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : []);

/**
 * A proposal as its owner reads it: every item whole, with the keys of its input that are ids
 * (`refs`), and a name for each of those ids as they are now. An id with no name here names
 * nothing of the owner's: the Inbox says so.
 */
export async function proposalView(db: Db, ownerId: string, proposalId: string) {
  const [row] = await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.ownerId, ownerId)));
  if (!row) return null;
  const wanted = new Map<ProposalName["kind"], Set<string>>();
  for (const item of row.items) {
    for (const [key, kind] of Object.entries(REFS[item.tool] ?? {})) {
      const ids = strings(((item.input ?? {}) as Record<string, unknown>)[key]).filter((id) => !(key === "dataTables" && id === "all"));
      if (!wanted.has(kind)) wanted.set(kind, new Set());
      for (const id of ids) wanted.get(kind)!.add(id);
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
    id: row.id,
    status: row.status,
    items: row.items.map(({ tool, input, usedAt }) => ({ tool, input, used: usedAt !== undefined, refs: Object.keys(REFS[tool] ?? {}) })),
    names,
  };
}
