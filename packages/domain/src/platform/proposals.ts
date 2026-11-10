import { storable } from "@dispand/runner-protocol";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { proposals, type ProposalItem } from "../db/schema.ts";
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
