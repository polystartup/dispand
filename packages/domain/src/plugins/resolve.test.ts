import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { answerApproval, answerConflict, decide, reopenChanged } from "./resolve.ts";
import { lawFirmMarket } from "./test-support.ts";

const OWNER = { type: "user" as const, userId: "" };

/** The law-firm plugin with its Drafting agent; its instructions overridden as "Mine" over the plugin's "Next". */
async function setUp() {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const fx = lawFirmMarket();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const entry = { marketplaceId: market.id, entryName: "law-firm" };
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context: ctx });
  const { reviewed } = await call(router.plugins.preview, entry, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { ...entry, reviewed, setup: { primitives: ["Clients", "Matters", "Research"], agents: [{ name: "Drafting", harnessId: harness.id }] } }, { context: ctx });
  const [agent] = await ctx.db.select().from(schema.agents).where(eq(schema.agents.pluginComponent, "Drafting"));
  const set = (values: Record<string, unknown>) => ctx.db.update(schema.agents).set(values).where(eq(schema.agents.id, agent!.id));
  await set({ systemPrompt: "Mine", overridden: ["systemPrompt"], upstream: { ...agent!.upstream, systemPrompt: "Next" } });
  /** A conflict on one of Drafting's fields handed to Stem, with the two values it was handed off against. */
  const conflict = async (field: string, mine: unknown, next: unknown) => {
    const id = `conflict_${field}`;
    await ctx.db.insert(schema.pluginConflicts).values({ id, ownerId: ctx.ownerId, pluginId, kind: "agent", elementId: agent!.id, field, old: null, mine, next, status: "stem" });
    return id;
  };
  const drafting = async () => (await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, agent!.id)))[0]!;
  const status = async (id: string) => (await ctx.db.select({ status: schema.pluginConflicts.status }).from(schema.pluginConflicts).where(eq(schema.pluginConflicts.id, id)))[0]?.status;
  const actor = { ...OWNER, userId: ctx.ownerId };
  return { ctx, agent: agent!, set, conflict, drafting, status, actor, remove: fx.remove };
}

test("a reset takes the plugin's value at once; a merge equal to the owner's value keeps it; each is in Audit by field name only", async () => {
  const t = await captureTelemetry();
  const s = await setUp();
  try {
    expect(await decide(s.ctx, s.actor, await s.conflict("systemPrompt", "Mine", "Next"), { kind: "reset" })).toBe("applied");
    expect(await s.drafting()).toMatchObject({ systemPrompt: "Next", overridden: [] });
    expect(await s.status("conflict_systemPrompt")).toBeUndefined();
    await s.set({ selfLearning: ["data"], overridden: ["selfLearning"], upstream: { ...(await s.drafting()).upstream, selfLearning: ["agent"] } });
    expect(await decide(s.ctx, s.actor, await s.conflict("selfLearning", ["data"], ["agent"]), { kind: "merge", value: ["data"] })).toBe("applied");
    expect((await s.drafting()).selfLearning).toEqual(["data"]);
    const rows = await s.ctx.db.select().from(schema.audit).where(eq(schema.audit.action, "plugin.decided"));
    expect(rows.map((r) => r.details)).toEqual([expect.objectContaining({ field: "systemPrompt", decision: "reset" }), expect.objectContaining({ field: "selfLearning", decision: "merge" })]);
    expect(await t.all()).not.toContain("Mine");
  } finally {
    t.stop();
    s.remove();
  }
});

test("a change to an agent's rights waits for the Approval, even within the two lists; keeping the owner's applies", async () => {
  const s = await setUp();
  try {
    await s.set({ selfLearning: ["data"], overridden: ["selfLearning"], upstream: { ...(await s.drafting()).upstream, selfLearning: ["agent"] } });
    const id = await s.conflict("selfLearning", ["data"], ["agent"]);
    // Rights combine: what is within both lists could still give more with the agent's other rights.
    expect(await decide(s.ctx, s.actor, id, { kind: "merge", value: ["data", "agent"] })).toBe("approval");
    expect((await s.drafting()).selfLearning).toEqual(["data"]);
    await s.ctx.db.update(schema.pluginConflicts).set({ status: "stem", merged: null }).where(eq(schema.pluginConflicts.id, id));
    expect(await decide(s.ctx, s.actor, id, { kind: "reset" })).toBe("approval");
    await s.ctx.db.update(schema.pluginConflicts).set({ status: "stem", merged: null }).where(eq(schema.pluginConflicts.id, id));
    expect(await decide(s.ctx, s.actor, id, { kind: "merge", value: ["data"] })).toBe("applied");
  } finally {
    s.remove();
  }
});

test("a decision on a field the owner changed since, or whose plugin value changed since, applies nothing and is the owner's again", async () => {
  const s = await setUp();
  try {
    const id = await s.conflict("systemPrompt", "Mine", "Next");
    await s.set({ systemPrompt: "Mine, edited" });
    expect(await decide(s.ctx, s.actor, id, { kind: "reset" })).toBe("reopened");
    expect(await s.status(id)).toBe("open");
    expect((await s.drafting()).systemPrompt).toBe("Mine, edited");

    await s.ctx.db.update(schema.pluginConflicts).set({ status: "stem", mine: "Mine, edited" }).where(eq(schema.pluginConflicts.id, id));
    await s.set({ upstream: { ...(await s.drafting()).upstream, systemPrompt: "Next, again" } });
    expect(await decide(s.ctx, s.actor, id, { kind: "reset" })).toBe("reopened");
    expect((await s.drafting()).systemPrompt).toBe("Mine, edited");
  } finally {
    s.remove();
  }
});

test("the Approval's yes applies the merged value, its no keeps the owner's, and one edited meanwhile applies nothing; an update changing a field reopens it", async () => {
  const s = await setUp();
  try {
    const trigger = await call(router.triggers.create, { agentId: s.agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: s.ctx });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: s.ctx });
    const id = await s.conflict("systemPrompt", "Mine", "Next");
    const handOff = (field: string) => s.ctx.db.update(schema.pluginConflicts).set({ runId, status: "stem", merged: null }).where(eq(schema.pluginConflicts.id, `conflict_${field}`));
    await handOff("systemPrompt");
    expect(await decide(s.ctx, s.actor, id, { kind: "merge", value: "Mine, and Next" })).toBe("approval");
    expect(await answerApproval(s.ctx, s.actor, runId, false)).toEqual({ applied: 0, reopened: 0 });
    expect((await s.drafting()).systemPrompt).toBe("Mine");

    const again = await s.conflict("systemPrompt", "Mine", "Next");
    await handOff("systemPrompt");
    await decide(s.ctx, s.actor, again, { kind: "merge", value: "Mine, and Next" });
    expect(await answerApproval(s.ctx, s.actor, runId, true)).toEqual({ applied: 1, reopened: 0 });
    expect((await s.drafting()).systemPrompt).toBe("Mine, and Next");

    const third = await s.conflict("systemPrompt", "Mine, and Next", "Next");
    await handOff("systemPrompt");
    await decide(s.ctx, s.actor, third, { kind: "merge", value: "Something else" });
    await s.set({ systemPrompt: "Edited meanwhile" });
    expect(await answerApproval(s.ctx, s.actor, runId, true)).toEqual({ applied: 0, reopened: 1 });
    expect((await s.drafting()).systemPrompt).toBe("Edited meanwhile");

    await s.ctx.db.update(schema.pluginConflicts).set({ status: "stem" }).where(eq(schema.pluginConflicts.id, third));
    await reopenChanged(s.ctx.db, "agent", s.agent.id, ["systemPrompt"]);
    expect(await s.status(third)).toBe("open");
  } finally {
    s.remove();
  }
});

test("a tool an agent gains through a decision starts with every action on Ask", async () => {
  const s = await setUp();
  try {
    // A server that calls its action read-only: given without a decision of the owner's, it would run unasked.
    await s.ctx.db.insert(schema.tools).values({ id: "tool_notes", ownerId: s.ctx.ownerId, name: "Notes", kind: "http", url: "https://notes.example.com/mcp", transport: "streamable-http", actions: [{ name: "read_note", description: "", inputSchema: {}, readOnly: true }] });
    const had = (await s.ctx.db.select({ id: schema.agentTools.toolId }).from(schema.agentTools).where(eq(schema.agentTools.agentId, s.agent.id))).map((t) => t.id);
    await s.set({ overridden: ["toolIds"], upstream: { ...(await s.drafting()).upstream, toolIds: [...had, "tool_notes"] } });
    const id = await s.conflict("toolIds", had, [...had, "tool_notes"]);
    // A change to its tools waits for the owner; accepted, the tool it gains asks before each action.
    expect(await decide(s.ctx, s.actor, id, { kind: "reset" })).toBe("approval");
    expect(await answerConflict(s.ctx, s.actor, id, true)).toBe("applied");
    const [grant] = await s.ctx.db.select().from(schema.agentTools).where(and(eq(schema.agentTools.agentId, s.agent.id), eq(schema.agentTools.toolId, "tool_notes")));
    expect(grant!.unasked).toEqual([]);
  } finally {
    s.remove();
  }
});

test("on the element's page, the owner decides a conflict on the values shown: take the plugin's, keep theirs, accept Stem's; a stale view is refused", async () => {
  const s = await setUp();
  try {
    const listed = () => call(router.plugins.conflicts, { kind: "agent", id: s.agent.id }, { context: s.ctx });
    const choose = async (id: string, choice: "plugin" | "mine" | "accept") => call(router.plugins.resolveConflict, { id, choice, reviewed: (await listed()).find((c) => c.id === id)!.reviewed }, { context: s.ctx });
    const id = await s.conflict("systemPrompt", "Mine", "Next");
    await s.ctx.db.update(schema.pluginConflicts).set({ status: "open" }).where(eq(schema.pluginConflicts.id, id));
    const [shown] = await listed();
    expect(shown).toMatchObject({ id, field: "systemPrompt", status: "open", mine: "Mine", next: "Next", merged: null });
    // Another update changes the plugin's value after the page was read: the choice is refused, and the page shows the new value.
    await s.set({ upstream: { ...(await s.drafting()).upstream, systemPrompt: "Newer" } });
    await expect(call(router.plugins.resolveConflict, { id, choice: "plugin", reviewed: shown!.reviewed }, { context: s.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await listed())[0]).toMatchObject({ next: "Newer" });
    await choose(id, "plugin");
    expect((await s.drafting()).systemPrompt).toBe("Newer");
    expect(await listed()).toEqual([]);

    await s.set({ systemPrompt: "Mine", overridden: ["systemPrompt"], upstream: { ...(await s.drafting()).upstream, systemPrompt: "Next" } });
    const again = await s.conflict("systemPrompt", "Mine", "Next");
    expect(await decide(s.ctx, s.actor, again, { kind: "merge", value: "Mine, and Next" })).toBe("approval");
    expect((await listed())[0]).toMatchObject({ status: "approval", merged: "Mine, and Next" });
    await choose(again, "accept");
    expect((await s.drafting()).systemPrompt).toBe("Mine, and Next");

    const third = await s.conflict("systemPrompt", "Mine, and Next", "Next");
    await s.ctx.db.update(schema.pluginConflicts).set({ status: "open" }).where(eq(schema.pluginConflicts.id, third));
    await choose(third, "mine");
    expect((await s.drafting()).systemPrompt).toBe("Mine, and Next");
    expect(await listed()).toEqual([]);
  } finally {
    s.remove();
  }
});
