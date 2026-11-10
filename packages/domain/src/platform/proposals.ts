import { storable } from "@dispand/runner-protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents, harnesses, proposals, runners, skillPackages, tables, tools as toolsTable, type ProposalItem } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { canonical } from "./approvals.ts";
import type { JobIdentity } from "./call.ts";
import type { PlatformTool } from "./tools.ts";

// Proposals: what changes what agents may do is a person's decision. An agent lists the exact
// writes it wants to make (each a tool marked `grant`, with its input), asks for them with
// `request_approval`, and may then make exactly those, once each. The owner reads the list from
// this row, never from the agent's words.

/** A proposal is shown whole: no more writes than this, and no more than this as JSON. */
export const MAX_ITEMS = 20;
export const MAX_BYTES = 64 * 1024;

export const ProposeInput = z.object({
  items: z
    .array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }))
    .describe("The writes to approve: each a tool's name and the exact input you will call it with"),
});

const everyString = (value: unknown, ok: (s: string) => boolean): boolean =>
  typeof value === "string" ? ok(value) : Array.isArray(value) ? value.every((v) => everyString(v, ok)) : value !== null && typeof value === "object" ? Object.entries(value).every(([k, v]) => ok(k) && everyString(v, ok)) : true;

/**
 * Stores the writes a Job's agent proposes, as a draft. Each must be a grant tool the Job may
 * use, with an input that tool accepts: it is kept as the tool parsed it, which is what a later
 * call is compared with. Refused with the reason when it couldn't be shown whole.
 */
export async function createProposal(db: Db, job: JobIdentity, tools: PlatformTool[], input: unknown): Promise<{ proposalId: string } | { error: string }> {
  const parsed = ProposeInput.safeParse(input);
  if (!parsed.success) return { error: "propose needs items: each a tool's name and its input" };
  if (parsed.data.items.length === 0) return { error: "A proposal lists at least one write" };
  if (parsed.data.items.length > MAX_ITEMS) return { error: `A proposal lists at most ${MAX_ITEMS} writes: make several` };
  const items: ProposalItem[] = [];
  for (const [i, item] of parsed.data.items.entries()) {
    const tool = tools.find((t) => t.name === item.tool && t.grant);
    if (!tool) return { error: `Item ${i + 1}: ${item.tool} is not a write you can propose` };
    const given = tool.input.safeParse(item.input);
    if (!given.success) return { error: `Item ${i + 1} (${item.tool}): ${given.error.issues.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join("; ")}` };
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

export type ProposalName = { kind: "agent" | "harness" | "tool" | "skill" | "table"; name: string; detail?: string };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : []);

/**
 * A proposal as its owner reads it: every item whole, and a name for each id an item points at
 * (the agent it changes, the harness, the tools, skills and tables), as they are now. An id
 * with no name here names nothing of the owner's: the Inbox says so.
 */
export async function proposalView(db: Db, ownerId: string, proposalId: string) {
  const [row] = await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.ownerId, ownerId)));
  if (!row) return null;
  const inputs = row.items.map((item) => (item.input ?? {}) as Record<string, unknown>);
  const ids = (key: string) => [...new Set(inputs.flatMap((input) => strings(input[key])))];
  const names: Record<string, ProposalName> = {};
  const found = async <T extends { id: string }>(wanted: string[], load: (wanted: string[]) => Promise<T[]>, name: (row: T) => ProposalName) => {
    for (const r of wanted.length ? await load(wanted) : []) names[r.id] = name(r);
  };
  await found(
    ids("id"),
    (w) => db.select({ id: agents.id, name: agents.name }).from(agents).where(and(inArray(agents.id, w), eq(agents.ownerId, ownerId))),
    (r) => ({ kind: "agent", name: r.name }),
  );
  await found(
    ids("harnessId"),
    (w) =>
      db
        .select({ id: harnesses.id, name: harnesses.name, kind: harnesses.kind, permissionMode: harnesses.permissionMode, runner: runners.name })
        .from(harnesses)
        .leftJoin(runners, eq(runners.id, harnesses.runnerId))
        .where(and(inArray(harnesses.id, w), eq(harnesses.ownerId, ownerId))),
    (r) => ({ kind: "harness", name: r.name, detail: [r.kind, r.runner ? `on ${r.runner}` : null, r.permissionMode ? `permission mode ${r.permissionMode}` : null].filter(Boolean).join(", ") }),
  );
  await found(
    ids("toolIds"),
    (w) => db.select({ id: toolsTable.id, name: toolsTable.name, kind: toolsTable.kind, url: toolsTable.url }).from(toolsTable).where(and(inArray(toolsTable.id, w), eq(toolsTable.ownerId, ownerId))),
    (r) => ({ kind: "tool", name: r.name, detail: r.kind === "http" ? (r.url ?? "") : "on a runner" }),
  );
  await found(
    ids("skillPackageIds"),
    (w) => db.select({ id: skillPackages.id, name: skillPackages.name }).from(skillPackages).where(and(inArray(skillPackages.id, w), eq(skillPackages.ownerId, ownerId))),
    (r) => ({ kind: "skill", name: r.name }),
  );
  await found(
    ids("dataTables").filter((id) => id !== "all"),
    (w) => db.select({ id: tables.id, name: tables.name }).from(tables).where(and(inArray(tables.id, w), eq(tables.ownerId, ownerId))),
    (r) => ({ kind: "table", name: r.name }),
  );
  return { id: row.id, status: row.status, items: row.items.map(({ tool, input, usedAt }) => ({ tool, input, used: usedAt !== undefined })), names };
}
