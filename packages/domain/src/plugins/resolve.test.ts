import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import * as schema from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { answerConflict, closeStemJob, decide, reopenChanged } from "./resolve.ts";
import { lawFirmMarket } from "./test-support.ts";
import { writeFields } from "./write-field.ts";
import { rememberAllowedAction } from "../agents/tool-ask.ts";
import { toolingOf } from "../engine/tooling.ts";
import { startFakeMcp } from "../tools/test-server.ts";

const OWNER = { type: "user" as const, userId: "" };

/** The law-firm plugin with its Drafting agent; its instructions overridden as "Mine" over the plugin's "Next". */
async function setUp() {
  const owner_ = await ownerContext();
  // What the plugin helpers called directly get from the member gate: the actor and the workspace.
  const ctx = { ...owner_, gitFileUrls: true, actorId: owner_.ownerId, access: { workspaceId: owner_.workspaceId } };
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

/** A Stem Job of the owner's (a Job of Drafting stands in), whose conflicts these are; `end` is its end, which asks the Approval. */
async function stemJob(s: Awaited<ReturnType<typeof setUp>>) {
  const trigger = await call(router.triggers.create, { agentId: s.agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: s.ctx });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: s.ctx });
  const handOff = (id: string) => s.ctx.db.update(schema.pluginConflicts).set({ runId, status: "stem", merged: null }).where(eq(schema.pluginConflicts.id, id));
  // The Approval is asked once its Job is over, as a Stem Job's end asks it.
  await vi.waitFor(async () => expect(["succeeded", "failed"]).toContain((await s.ctx.db.select({ status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, runId)))[0]!.status), { timeout: 10_000 });
  const end = () => s.ctx.db.transaction((tx) => closeStemJob(tx, runId));
  const approval = async () => (await call(router.questions.list, { status: "all" }, { context: s.ctx })).filter((q) => q.update);
  return { runId, handOff, end, approval };
}

/** Drafting's description overridden too, as "Mine too" over the plugin's "Next too": two texts in conflict. */
async function twoMerged(s: Awaited<ReturnType<typeof setUp>>) {
  await s.set({ description: "Mine too", overridden: ["systemPrompt", "description"], upstream: { ...(await s.drafting()).upstream, description: "Next too" } });
  const job = await stemJob(s);
  const prompt = await s.conflict("systemPrompt", "Mine", "Next");
  const description = await s.conflict("description", "Mine too", "Next too");
  await job.handOff(prompt);
  await job.handOff(description);
  expect(await decide(s.ctx, s.actor, prompt, { kind: "merge", value: "Mine, and Next" }, job.runId)).toBe("approval");
  expect(await decide(s.ctx, s.actor, description, { kind: "merge", value: "Mine too, and Next too" }, job.runId)).toBe("approval");
  return { ...job, prompt, description };
}

test("two merged texts of one update make one Inbox Approval with two items: a yes applies one, a no keeps the owner's, and the Approval is done once both are answered", async () => {
  const s = await setUp();
  try {
    const job = await twoMerged(s);
    // Nothing in the Inbox while the Job decides; one Approval when it ends.
    expect(await job.approval()).toEqual([]);
    expect(await job.end()).toMatchObject({ kind: "approval", status: "pending" });
    const [item] = await job.approval();
    expect(item).toMatchObject({ status: "pending", kind: "approval", update: { plugin: { name: "law-firm" } } });
    expect(item!.update!.items).toHaveLength(2);
    expect(item!.update!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.prompt, kind: "agent", elementId: s.agent.id, name: "Drafting", field: "systemPrompt", mine: "Mine", merged: "Mine, and Next" }),
      expect.objectContaining({ id: job.description, field: "description", mine: "Mine too", merged: "Mine too, and Next too" }),
    ]));
    expect(await call(router.questions.count, undefined, { context: s.ctx })).toEqual({ count: 1 });
    // Not answered whole.
    await expect(call(router.questions.answer, { questionId: item!.id, answer: { kind: "permission", decision: "allow" } }, { context: s.ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const answer = async (id: string, choice: "accept" | "decline") => {
      const [shown] = await job.approval();
      await call(router.plugins.resolveConflict, { id, choice, reviewed: shown!.update!.items.find((i) => i.id === id)!.reviewed }, { context: s.ctx });
    };
    await answer(job.prompt, "accept");
    expect((await s.drafting()).systemPrompt).toBe("Mine, and Next");
    const [left] = await job.approval();
    expect(left).toMatchObject({ status: "pending" });
    expect(left!.update!.items.map((i) => i.id)).toEqual([job.description]);
    await answer(job.description, "decline");
    expect((await s.drafting()).description).toBe("Mine too");
    const [done] = await job.approval();
    expect(done).toMatchObject({ status: "answered", answeredBy: { type: "user", userId: s.ctx.ownerId }, update: { items: [] } });
    expect(await call(router.questions.count, undefined, { context: s.ctx })).toEqual({ count: 0 });
  } finally {
    s.remove();
  }
});

test("an owner edit meanwhile reopens that item only; the element's page links to the Approval; an update reopening the last item takes the Approval out of the Inbox", async () => {
  const s = await setUp();
  try {
    const job = await twoMerged(s);
    const listed = () => call(router.plugins.conflicts, { kind: "agent", id: s.agent.id }, { context: s.ctx });
    // Before the Job ends there is no Approval to link to yet.
    expect((await listed()).map((c) => c.approvalId)).toEqual([null, null]);
    const approval = await job.end();
    expect((await listed()).map((c) => [c.field, c.approvalId])).toEqual([["description", approval!.id], ["systemPrompt", approval!.id]]);

    await s.set({ systemPrompt: "Edited meanwhile" });
    expect(await answerConflict(s.ctx, s.actor, job.prompt, true)).toBe("reopened");
    expect((await s.drafting()).systemPrompt).toBe("Edited meanwhile");
    expect(await s.status(job.prompt)).toBe("open");
    expect(await s.status(job.description)).toBe("approval");
    const [item] = await job.approval();
    expect(item).toMatchObject({ status: "pending" });
    expect(item!.update!.items.map((i) => i.id)).toEqual([job.description]);

    // An update that changes the plugin's description: its item is the owner's again, and nothing is left to approve.
    await reopenChanged(s.ctx.db, "agent", s.agent.id, ["description"]);
    expect(await s.status(job.description)).toBe("open");
    expect(await job.approval()).toEqual([expect.objectContaining({ status: "expired" })]);
    expect((await s.drafting()).description).toBe("Mine too");
  } finally {
    s.remove();
  }
});

test("a Stem Job's end with nothing waiting asks nothing; an update changing a field reopens what Stem was deciding", async () => {
  const s = await setUp();
  try {
    const job = await stemJob(s);
    const id = await s.conflict("systemPrompt", "Mine", "Next");
    await job.handOff(id);
    await reopenChanged(s.ctx.db, "agent", s.agent.id, ["systemPrompt"]);
    expect(await s.status(id)).toBe("open");
    expect(await job.end()).toBeNull();
    expect(await job.approval()).toEqual([]);
  } finally {
    s.remove();
  }
});

test("a tool an agent gains through a decision starts with every action on Ask", async () => {
  const s = await setUp();
  try {
    // A server that calls its action read-only: given without a decision of the owner's, it would run unasked.
    await s.ctx.db.insert(schema.tools).values({ id: "tool_notes", ownerId: s.ctx.ownerId, workspaceId: s.ctx.workspaceId, name: "Notes", kind: "http", url: "https://notes.example.com/mcp", transport: "streamable-http", actions: [{ name: "read_note", description: "", inputSchema: {}, readOnly: true }] });
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

test("a reset that points a skill's tool back at the plugin's server makes the choice remembered for it ask again", async () => {
  const s = await setUp();
  const echo = { name: "echo", description: "", inputSchema: { type: "object" }, call: () => ({ content: [] }) };
  const mine = await startFakeMcp([echo]);
  const next = await startFakeMcp([echo]);
  try {
    const pluginId = (await s.drafting()).pluginId!;
    await s.ctx.db.insert(schema.tools).values({ id: "tool_echo", ownerId: s.ctx.ownerId, workspaceId: s.ctx.workspaceId, name: "Echo", kind: "http", url: mine.url, transport: "streamable-http", actions: [{ name: "echo", description: "", inputSchema: {} }], pluginId, pluginComponent: "echo", upstream: { name: "Echo", url: next.url, transport: "streamable-http" }, overridden: ["url"] });
    const { packageId } = await call(router.skills.create, { name: "echoing", description: "Echoes.", instructions: "x", requiredToolIds: ["tool_echo"] }, { context: s.ctx });
    await s.ctx.db.insert(schema.agentSkills).values({ agentId: s.agent.id, packageId });
    const unasked = async () => (await toolingOf(s.ctx.db, { workspaceId: s.ctx.workspaceId, snapshot: null }, s.agent.id)).httpTools.find((t) => t.id === "tool_echo")!.unasked;
    expect(await rememberAllowedAction(s.ctx.db, s.ctx.workspaceId, { agentId: s.agent.id, toolId: "tool_echo", action: "echo" })).toBe(true);
    expect(await unasked()).toEqual(["echo"]);
    await s.ctx.db.insert(schema.pluginConflicts).values({ id: "conflict_url", ownerId: s.ctx.ownerId, pluginId, kind: "tool", elementId: "tool_echo", field: "url", old: null, mine: mine.url, next: next.url, status: "stem" });
    // Taking the plugin's own value applies at once.
    expect(await decide(s.ctx, s.actor, "conflict_url", { kind: "reset" })).toBe("applied");
    expect((await s.ctx.db.select({ url: schema.tools.url }).from(schema.tools).where(eq(schema.tools.id, "tool_echo")))[0]!.url).toBe(next.url);
    expect(await unasked()).toEqual([]);
  } finally {
    await Promise.all([mine.close(), next.close()]);
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

test("an element's update with an expected field value refuses when the field changed, and writes when it didn't: agents, tools and triggers", async () => {
  const s = await setUp();
  try {
    const expecting = (value: unknown, field: string) => ({ ...s.ctx, expectField: { field, value } });
    // An agent: its instructions are "Mine".
    await expect(writeFields(expecting("Not mine", "systemPrompt"), "agent", s.agent.id, { systemPrompt: "Stem's" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await s.drafting()).systemPrompt).toBe("Mine");
    await writeFields(expecting("Mine", "systemPrompt"), "agent", s.agent.id, { systemPrompt: "Stem's" });
    expect((await s.drafting()).systemPrompt).toBe("Stem's");
    // A tool, compared in its write.
    const tool = await call(router.tools.create, { name: "Notes", url: "https://notes.example.com/mcp", transport: "streamable-http", headers: {} }, { context: s.ctx });
    await expect(writeFields(expecting("Other", "name"), "tool", tool.id, { name: "Notes 2" })).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFields(expecting("Notes", "name"), "tool", tool.id, { name: "Notes 2" });
    expect((await s.ctx.db.select().from(schema.tools).where(eq(schema.tools.id, tool.id)))[0]!.name).toBe("Notes 2");
    // A trigger, under its row lock.
    const trigger = await call(router.triggers.create, { agentId: s.agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: s.ctx });
    await expect(writeFields(expecting("Stop.", "instructions"), "trigger", trigger.id, { instructions: "Work hard." })).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFields(expecting("Work.", "instructions"), "trigger", trigger.id, { instructions: "Work hard." });
    expect((await s.ctx.db.select().from(schema.triggers).where(eq(schema.triggers.id, trigger.id)))[0]!.instructions).toBe("Work hard.");
  } finally {
    s.remove();
  }
});
