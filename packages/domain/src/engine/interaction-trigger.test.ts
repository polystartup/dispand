import { call } from "@orpc/server";
import type { QuestionPayload } from "@dispand/runner-protocol";
import { and, asc, eq, isNull } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Bundle, TableScope } from "../platform/bundles.ts";
import { eventFires, events, questions, roots, runs, stepRuns, workspaceSettings } from "../db/schema.ts";
import { agentScope, jobScope, reachable } from "../questions/inbox-scope.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { INTERACTION } from "../triggers/model.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { recordInteraction } from "./interactions.ts";
import { pause } from "./roots.ts";
import { Scheduler } from "./scheduler.ts";

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop() {
    return true;
  }
}

const SECRET = "Should the merger with the other firm go ahead?";
const choice: QuestionPayload = { kind: "choice", questions: [{ question: SECRET, header: "Merger", options: [{ label: "Yes, sign it" }, { label: "No" }], multiSelect: false }] };
const permission: QuestionPayload = { kind: "permission", toolName: "Bash", input: { command: "rm -rf build" }, canAlwaysAllow: false };

/**
 * Clients and Notes (primitive). A person's write to either starts a Job of the agent watching
 * it; that Job asks. The Answerer (`inbox` on Clients) is started by what it is asked.
 */
async function setup(opts: { checkpoint?: number } = {}) {
  const context = await ownerContext();
  if (opts.checkpoint) await context.db.insert(workspaceSettings).values({ ownerId: context.ownerId, checkpoint: opts.checkpoint });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const table = async (name: string) => {
    const t = await call(router.tables.create, { name }, { context });
    await call(router.tables.setPrimitive, { id: t.id, primitive: true }, { context });
    return { id: t.id, field: (await call(router.tables.get, { id: t.id }, { context })).fields[0]! };
  };
  const clients = await table("Clients");
  const notes = await table("Notes");
  const agent = (name: string, bundles: Bundle[], dataTables: TableScope) => call(router.agents.create, { name, harnessId: harness.id, systemPrompt: "", bundles, dataTables }, { context });
  const setRights = (a: { id: string; name: string }, bundles: Bundle[], dataTables: TableScope) =>
    call(router.agents.update, { id: a.id, name: a.name, harnessId: harness.id, systemPrompt: "", bundles, dataTables }, { context });
  const onRow = (agentId: string, tableId: string) =>
    call(router.triggers.create, { agentId, name: "On row", instructions: "Look.", config: { kind: "primitive", tableId, operations: ["created"] } }, { context });
  const onInteraction = (agentId: string, operations: ("created" | "answered" | "expired")[] = ["created"]) =>
    call(router.triggers.create, { agentId, name: "On question", instructions: "Help with it.", config: { kind: "primitive", tableId: INTERACTION, operations } }, { context });
  const answerer = await agent("Answerer", ["inbox"], [clients.id]);
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(context.db, engine);
  let seq = 0;
  /** A person adds a row: the watching agent's Job starts. */
  const write = async (t: { id: string; field: { id: string } }) => {
    await call(router.rows.create, { tableId: t.id, values: { [t.field.id]: "x" } }, { context });
    return scheduler.tick();
  };
  /** The Job's session asks; returns the item. */
  const ask = async (runId: string, payload: QuestionPayload = choice) => {
    const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    await engine.onHarnessEvent(step!.sessionId!, { type: "question", questionId: `rq_${++seq}`, payload }, { runnerId, seq });
    const [q] = await context.db.select().from(questions).where(and(eq(questions.runId, runId), eq(questions.runnerQuestionId, `rq_${seq}`)));
    return q!;
  };
  const eventsOf = (rowId: string) => context.db.select().from(events).where(and(eq(events.tableId, INTERACTION), eq(events.rowId, rowId))).orderBy(asc(events.createdAt));
  const firesOf = (triggerId: string) => context.db.select().from(eventFires).where(eq(eventFires.triggerId, triggerId)).orderBy(asc(eventFires.createdAt));
  const jobsOf = (triggerId: string) => context.db.select().from(runs).where(eq(runs.triggerId, triggerId)).orderBy(asc(runs.createdAt));
  const by = { type: "user" as const, userId: context.ownerId };
  return { context, adapter, engine, scheduler, clients, notes, agent, setRights, onRow, onInteraction, answerer, write, ask, eventsOf, firesOf, jobsOf, by };
}

test("asking, answering and expiring each record one event, with ids and kinds only; a write rolled back records none", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  await s.onRow(clerk.id, s.clients.id);
  const [job] = await s.write(s.clients);
  const q = await s.ask(job!);
  const [step] = await s.context.db.select().from(stepRuns).where(eq(stepRuns.runId, job!));
  const after = { kind: "question", runId: job, agentId: clerk.id, stepRunId: step!.id };
  expect((await s.eventsOf(q.id)).map((e) => [e.operation, e.after, e.actor])).toEqual([["created", after, { type: "job", runId: job }]]);
  await s.engine.answer(q.id, { kind: "choice", answers: { [SECRET]: "Yes, sign it" } }, s.by);
  // Once: a second answer is refused and records nothing.
  await expect(s.engine.answer(q.id, { kind: "choice", answers: { [SECRET]: "No" } }, s.by)).rejects.toThrow();
  const other = await s.ask(job!);
  await s.engine.stopRun(job!);
  expect((await s.eventsOf(q.id)).map((e) => [e.operation, e.actor])).toEqual([
    ["created", { type: "job", runId: job }],
    ["answered", s.by],
  ]);
  expect((await s.eventsOf(other.id)).map((e) => e.operation)).toEqual(["created", "expired"]);
  const [root] = await s.context.db.select({ rootId: runs.rootId }).from(runs).where(eq(runs.id, job!));
  for (const e of [...(await s.eventsOf(q.id)), ...(await s.eventsOf(other.id))]) {
    expect(JSON.stringify(e)).not.toContain("merger");
    expect(e.rootId).toBe(root!.rootId);
  }
  // In the write's transaction: rolled back together.
  await expect(
    s.context.db.transaction(async (tx) => {
      await recordInteraction(tx, { ...q, id: "q_rolled_back" }, "answered");
      throw new Error("the write failed");
    }),
  ).rejects.toThrow("the write failed");
  expect(await s.eventsOf("q_rolled_back")).toEqual([]);
});

test("a trigger on a Question asked starts a Job whose prompt holds its id and kind, never its text", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  await s.onRow(clerk.id, s.clients.id);
  const trigger = await s.onInteraction(s.answerer.id);
  const [job] = await s.write(s.clients);
  const q = await s.ask(job!);
  const [started] = await s.scheduler.tick();
  expect(started).toBeDefined();
  const prompt = s.adapter.starts.at(-1)!.start.prompt;
  expect(prompt).toContain("Help with it.");
  expect(prompt).toContain(`- Item: ${q.id}`);
  expect(prompt).toContain('"kind":"question"');
  expect(prompt).toContain("- What happened: created");
  expect(prompt).not.toContain("merger");
  expect(prompt).not.toContain("sign it");
  const [answering] = await s.jobsOf(trigger.id);
  expect(answering!.cause).toMatchObject({ kind: "event", jobId: job, depth: 1 });
  expect(answering!.rootId).toBe((await s.context.db.select().from(runs).where(eq(runs.id, job!)))[0]!.rootId);
});

test("at dispatch, an Approval, a Question of a Job with configure and one of a Job on tables beyond the agent's start no Job: out of scope", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  const builder = await s.agent("Builder", ["data", "configure"], [s.clients.id]);
  const wide = await s.agent("Wide", ["data"], [s.clients.id, s.notes.id]);
  await s.onRow(clerk.id, s.clients.id);
  await s.onRow(builder.id, s.clients.id);
  await s.onRow(wide.id, s.clients.id);
  const trigger = await s.onInteraction(s.answerer.id);
  const jobs = await s.write(s.clients);
  expect(jobs).toHaveLength(3);
  const ofAgent = async (agentId: string) => {
    for (const id of jobs) if ((await s.context.db.select().from(runs).where(eq(runs.id, id)))[0]!.agentId === agentId) return id;
    throw new Error("no Job");
  };
  await s.ask(await ofAgent(clerk.id), permission);
  await s.ask(await ofAgent(builder.id));
  await s.ask(await ofAgent(wide.id));
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(trigger.id)).map((f) => [f.status, f.runId])).toEqual([
    ["out-of-scope", null],
    ["out-of-scope", null],
    ["out-of-scope", null],
  ]);
  expect(await s.jobsOf(trigger.id)).toEqual([]);
  expect(await s.context.db.select().from(events).where(isNull(events.processedAt))).toEqual([]);
});

test("the asking agent's own trigger on Questions never fires for its Jobs' Questions", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data", "inbox"], [s.clients.id]);
  await s.onRow(clerk.id, s.clients.id);
  const own = await s.onInteraction(clerk.id, ["created", "answered", "expired"]);
  const [job] = await s.write(s.clients);
  const q = await s.ask(job!);
  await s.engine.answer(q.id, { kind: "choice", answers: { [SECRET]: "No" } }, s.by);
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(own.id)).map((f) => f.status)).toEqual(["skipped-same-agent", "skipped-same-agent"]);
});

test("a trigger on Questions and Approvals needs the Inbox, and takes their operations only", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  await expect(s.onInteraction(clerk.id)).rejects.toThrow("Only an agent with the Inbox");
  await expect(
    call(router.triggers.create, { agentId: s.answerer.id, name: "x", instructions: "x", config: { kind: "primitive", tableId: INTERACTION, operations: ["updated"] } }, { context: s.context }),
  ).rejects.toThrow();
  await expect(
    call(router.triggers.create, { agentId: s.answerer.id, name: "x", instructions: "x", config: { kind: "primitive", tableId: s.clients.id, operations: ["answered"] } }, { context: s.context }),
  ).rejects.toThrow();
  const trigger = await s.onInteraction(s.answerer.id, ["answered", "expired"]);
  expect(trigger.config).toEqual({ kind: "primitive", tableId: INTERACTION, operations: ["answered", "expired"] });
});

test("a Question asked in a paused root waits with the root's events, and starts its Job once the root goes on", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  await s.onRow(clerk.id, s.clients.id);
  const trigger = await s.onInteraction(s.answerer.id);
  const [job] = await s.write(s.clients);
  const [run] = await s.context.db.select().from(runs).where(eq(runs.id, job!));
  // The root reaches its checkpoint: it pauses and asks a person.
  await s.context.db.transaction(async (tx) => {
    const [root] = await tx.select().from(roots).where(eq(roots.id, run!.rootId!)).for("update");
    await pause(tx, root!, root!.jobs, job!);
  });
  const q = await s.ask(job!);
  expect(await s.scheduler.tick()).toEqual([]);
  expect(await s.firesOf(trigger.id)).toEqual([]);
  expect((await s.eventsOf(q.id)).map((e) => e.processedAt)).toEqual([null]);
  const [approval] = await s.context.db.select().from(questions).where(eq(questions.rootId, run!.rootId!));
  await s.engine.answer(approval!.id, { kind: "permission", decision: "allow" }, s.by);
  const started = await s.scheduler.tick();
  expect(started).toHaveLength(1);
  // The checkpoint's Approval, asked and answered, is never the Answerer's.
  expect((await s.firesOf(trigger.id)).map((f) => f.status).sort()).toEqual(["out-of-scope", "started"]);
  expect((await s.jobsOf(trigger.id))[0]!.id).toBe(started[0]);
});

test("reachable with a Job's scope: a table granted later doesn't widen it, one taken away narrows it at once", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  const scout = await s.agent("Scout", ["data"], [s.notes.id]);
  await s.onRow(clerk.id, s.clients.id);
  await s.onRow(scout.id, s.notes.id);
  await s.onInteraction(s.answerer.id);
  const [clerkJob] = await s.write(s.clients);
  const onClients = await s.ask(clerkJob!);
  const [answering] = await s.scheduler.tick();
  const [scoutJob] = await s.write(s.notes);
  const onNotes = await s.ask(scoutJob!);
  const job = { runId: answering!, ownerId: s.context.ownerId, agentId: s.answerer.id };
  const now = async () => ({ job: (await jobScope(s.context.db, job))!, agent: (await agentScope(s.context.db, s.context.ownerId, s.answerer.id))! });
  let scope = await now();
  expect(await reachable(s.context.db, scope.job, onClients.id)).toBe(true);
  expect(await reachable(s.context.db, scope.job, onNotes.id)).toBe(false);
  // Granted Notes: the agent reaches it from now on; the Job made before does not.
  await s.setRights(s.answerer, ["inbox"], [s.clients.id, s.notes.id]);
  scope = await now();
  expect(await reachable(s.context.db, scope.agent, onNotes.id)).toBe(true);
  expect(await reachable(s.context.db, scope.job, onNotes.id)).toBe(false);
  // Clients taken away: the Job loses it at once.
  await s.setRights(s.answerer, ["inbox"], [s.notes.id]);
  scope = await now();
  expect(await reachable(s.context.db, scope.job, onClients.id)).toBe(false);
  expect(await reachable(s.context.db, scope.agent, onClients.id)).toBe(false);
});

test("a Job dispatched for a Question but held until its agent lost the Inbox ends before its prompt is sent", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  await s.onRow(clerk.id, s.clients.id);
  await s.onInteraction(s.answerer.id);
  const [job] = await s.write(s.clients);
  const q = await s.ask(job!);
  // Made, not started (its runner offline).
  const [held] = await s.scheduler.claim();
  await s.setRights(s.answerer, [], [s.clients.id]);
  const sent = s.adapter.starts.length;
  await s.engine.continueRun(held!);
  await vi.waitFor(async () => {
    const [run] = await s.context.db.select().from(runs).where(eq(runs.id, held!));
    expect(run).toMatchObject({ status: "failed", error: "The agent may no longer read this Question" });
  });
  expect(s.adapter.starts.slice(sent).some((st) => st.start.prompt?.includes(q.id))).toBe(false);
});

test("a Job of an answered or expired item, held for its runner, still starts: the item needn't be open", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  await s.onRow(clerk.id, s.clients.id);
  const trigger = await s.onInteraction(s.answerer.id, ["answered", "expired"]);
  const [job] = await s.write(s.clients);
  const answered = await s.ask(job!);
  const expired = await s.ask(job!);
  await s.engine.answer(answered.id, { kind: "choice", answers: { [SECRET]: "No" } }, s.by);
  await s.engine.stopRun(job!);
  const held = await s.scheduler.claim();
  expect(held).toHaveLength(2);
  for (const id of held) await s.engine.continueRun(id);
  const prompts = s.adapter.starts.map((st) => st.start.prompt ?? "");
  expect(prompts.some((p) => p.includes(`- Item: ${answered.id}`) && p.includes("- What happened: answered"))).toBe(true);
  expect(prompts.some((p) => p.includes(`- Item: ${expired.id}`) && p.includes("- What happened: expired"))).toBe(true);
  expect((await s.jobsOf(trigger.id)).map((r) => r.status).every((st) => st === "running")).toBe(true);
});

test("a Question answered while its asked event waited starts no Job; one answered before its Job's start sends nothing", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk", ["data"], [s.clients.id]);
  await s.onRow(clerk.id, s.clients.id);
  const trigger = await s.onInteraction(s.answerer.id);
  const [job] = await s.write(s.clients);
  // Closed before dispatch: out of scope, no Job.
  const early = await s.ask(job!);
  await s.engine.answer(early.id, { kind: "choice", answers: { [SECRET]: "No" } }, s.by);
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(trigger.id)).map((f) => [f.status, f.runId])).toEqual([["out-of-scope", null]]);
  // Closed after dispatch, before its start: the Job ends, its prompt never sent.
  const late = await s.ask(job!);
  const [held] = await s.scheduler.claim();
  await s.engine.answer(late.id, { kind: "choice", answers: { [SECRET]: "No" } }, s.by);
  await s.engine.continueRun(held!);
  await vi.waitFor(async () => {
    const [run] = await s.context.db.select().from(runs).where(eq(runs.id, held!));
    expect(run).toMatchObject({ status: "failed" });
  });
  expect(s.adapter.starts.some((st) => st.start.prompt?.includes(late.id) || st.start.prompt?.includes(early.id))).toBe(false);
});
