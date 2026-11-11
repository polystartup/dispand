import { call } from "@orpc/server";
import type { Answer } from "@dispand/runner-protocol";
import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { eventFires, events, harnesses, questions, roots, runs, stepRuns, workspaceSettings } from "../db/schema.ts";
import { callPlatformTool } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { INTERACTION } from "../triggers/model.ts";
import { Engine, STOPPED } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  sent: [string, string][] = [];
  answers: [string, string, Answer][] = [];
  stops: string[] = [];
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send(sessionId: string, text: string) {
    this.sent.push([sessionId, text]);
    return true;
  }
  async answer(sessionId: string, questionId: string, answer: Answer) {
    this.answers.push([sessionId, questionId, answer]);
    return true;
  }
  async stop(sessionId: string) {
    this.stops.push(sessionId);
    return true;
  }
  /** Everything sent to a runner so far, to compare before and after. */
  get all() {
    return this.starts.length + this.sent.length + this.answers.length;
  }
}

/**
 * Clients (primitive: Name, City) watched by a Clerk and an Auditor, each told of every update:
 * a Job of one that writes the row fires the other, so the two write to each other without end.
 */
async function setup(checkpoint: number, maxWorking = 100) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  await context.db.update(harnesses).set({ maxWorking }).where(eq(harnesses.id, harness.id));
  await context.db.insert(workspaceSettings).values({ ownerId: context.ownerId, checkpoint });
  const agent = (name: string) => call(router.agents.create, { name, harnessId: harness.id, systemPrompt: "", bundles: ["data"] }, { context });
  const clerk = await agent("Clerk");
  const auditor = await agent("Auditor");
  const clients = await call(router.tables.create, { name: "Clients" }, { context });
  const name = (await call(router.tables.get, { id: clients.id }, { context })).fields[0]!;
  const city = await call(router.fields.create, { tableId: clients.id, name: "City", type: "text" }, { context });
  await call(router.tables.setPrimitive, { id: clients.id, primitive: true }, { context });
  const watch = (agentId: string, extra: { rateCap?: number } = {}) =>
    call(router.triggers.create, { agentId, name: "On change", instructions: "Look.", ...extra, config: { kind: "primitive", tableId: clients.id, operations: ["updated"] } }, { context });
  const clerkTrigger = await watch(clerk.id);
  const auditorTrigger = await watch(auditor.id);
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(context.db, engine);
  const ada = await call(router.rows.create, { tableId: clients.id, values: { [name.id]: "Ada" } }, { context });
  let n = 0;
  /** A person's write: a root cause of its own. */
  const personWrites = () => call(router.rows.update, { id: ada.id, values: { [city.id]: `p${++n}` } }, { context });
  /** Each Job writes the row once, as its agent's tool call. */
  const jobsWrite = async (runIds: string[]) => {
    for (const runId of runIds) {
      const [job] = await context.db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, runId));
      const done = await callPlatformTool(context, { runId, ownerId: context.ownerId, agentId: job!.agentId! }, "rows_update", { id: ada.id, values: { [city.id]: `j${++n}` } });
      expect(done).toMatchObject({ ok: true });
    }
  };
  const approvals = () => context.db.select().from(questions).where(isNotNull(questions.rootId)).orderBy(asc(questions.createdAt));
  const pendingApproval = async () => (await approvals()).filter((q) => q.status === "pending");
  const rootOf = async (runId: string) => {
    const [row] = await context.db.select({ root: roots }).from(runs).innerJoin(roots, eq(roots.id, runs.rootId)).where(eq(runs.id, runId));
    return row!.root;
  };
  // The rows' writes that wait (a checkpoint's Approval is an `interaction` event of the root too, and waits with them).
  const unprocessed = () => context.db.select().from(events).where(and(isNull(events.processedAt), ne(events.tableId, INTERACTION)));
  let seq = 0;
  const emit = (sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  const sessionOf = async (runId: string) => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)))[0]!;
  return { context, runnerId, harness, clerk, auditor, clerkTrigger, auditorTrigger, clients, city, name, ada, adapter, engine, scheduler, personWrites, jobsWrite, approvals, pendingApproval, rootOf, unprocessed, emit, sessionOf, watch };
}

/** The Job writes the row and the scheduler claims it: one more Job of its root, which reaches the checkpoint. */
async function pauseBy(s: Awaited<ReturnType<typeof setup>>, runId: string) {
  await s.jobsWrite([runId]);
  const made = await s.scheduler.tick();
  expect(made).toHaveLength(1);
  expect(await s.rootOf(runId)).toMatchObject({ state: "paused" });
  return made[0]!;
}

/** Each tick's new Jobs write the row, until a tick makes none; returns every Job made. */
async function relay(s: Awaited<ReturnType<typeof setup>>, rounds: number) {
  const made: string[] = [];
  let last = await s.scheduler.tick();
  made.push(...last);
  for (let i = 0; i < rounds && last.length > 0; i++) {
    await s.jobsWrite(last);
    last = await s.scheduler.tick();
    made.push(...last);
  }
  return made;
}

const approve: Answer = { kind: "permission", decision: "allow" };
const dontAsk: Answer = { kind: "permission", decision: "allow-always" };
const decline: Answer = { kind: "permission", decision: "deny" };
const by = (s: { context: { ownerId: string } }) => ({ type: "user" as const, userId: s.context.ownerId });

test("a loop of two agents pauses at the checkpoint with one Approval; approving goes on to the next; don't ask again ends them", async () => {
  const s = await setup(4);
  await s.personWrites();
  // The person's write: two Jobs; their writes: two more, which reach the checkpoint.
  const made = await relay(s, 10);
  expect(made).toHaveLength(4);
  const root = await s.rootOf(made[0]!);
  expect(root).toMatchObject({ kind: "event", jobs: 4, state: "paused" });
  const [asked, ...more] = await s.approvals();
  expect(more).toEqual([]);
  expect(asked).toMatchObject({ status: "pending", kind: "approval", rootId: root.id, runId: made[3], sessionId: null, placement: "notifications" });
  expect(asked!.payload).toMatchObject({ kind: "permission", toolName: "checkpoint", canAlwaysAllow: true, input: { root: "A change to a table", jobs: 4, agents: ["Auditor", "Clerk"] } });
  // The last Jobs' writes wait, unclaimed: nothing is lost.
  expect(await s.unprocessed()).toHaveLength(2);

  await s.engine.answer(asked!.id, approve, by(s));
  expect((await s.rootOf(made[0]!)).state).toBe("going");
  const next = await relay(s, 10);
  expect(next).toHaveLength(4);
  expect(await s.rootOf(made[0]!)).toMatchObject({ jobs: 8, state: "paused", countedFrom: 4 });
  const second = await s.pendingApproval();
  expect(second).toHaveLength(1);

  await s.engine.answer(second[0]!.id, dontAsk, by(s));
  const rest = await relay(s, 5);
  expect(rest.length).toBeGreaterThanOrEqual(10);
  expect(await s.rootOf(made[0]!)).toMatchObject({ state: "going", dontAsk: true });
  expect(await s.approvals()).toHaveLength(2);
});

test("the event that reaches the checkpoint still makes every Job its triggers call for", async () => {
  const s = await setup(2);
  const watcher = await call(router.agents.create, { name: "Watcher", harnessId: s.harness.id, systemPrompt: "", bundles: ["data"] }, { context: s.context });
  await s.watch(watcher.id);
  await s.personWrites();
  const made = await s.scheduler.tick();
  expect(made).toHaveLength(3);
  expect(await s.rootOf(made[0]!)).toMatchObject({ jobs: 3, state: "paused" });
  expect(await s.pendingApproval()).toHaveLength(1);
  // Made, but none of their sessions starts while the root is paused: they start once approved.
  expect(s.adapter.starts).toEqual([]);
  await s.engine.answer((await s.pendingApproval())[0]!.id, approve, by(s));
  expect(s.adapter.starts).toHaveLength(3);
});

test("two schedulers claiming events of one root near its checkpoint make one Approval", async () => {
  const s = await setup(3);
  await s.personWrites();
  const [first] = await s.scheduler.tick();
  const clerkJob = (await s.context.db.select().from(runs).where(eq(runs.triggerId, s.clerkTrigger.id)))[0]!;
  // The Clerk's Job writes twice: two events of the root, each worth one Auditor Job.
  await s.jobsWrite([clerkJob.id, clerkJob.id]);
  const other = new Scheduler(s.context.db, s.engine);
  const [a, b] = await Promise.all([s.scheduler.tick(), other.tick()]);
  expect([...a, ...b]).toHaveLength(1);
  expect(await s.rootOf(first!)).toMatchObject({ jobs: 3, state: "paused" });
  expect(await s.pendingApproval()).toHaveLength(1);
  expect(await s.unprocessed()).toHaveLength(1);
});

test("declining stops the root's Jobs, processes its held events, closes its deferred fires, and nothing of it comes back", async () => {
  const s = await setup(3);
  // A third agent, one Job an hour: its later fires of the root wait, deferred.
  const watcher = await call(router.agents.create, { name: "Watcher", harnessId: s.harness.id, systemPrompt: "", bundles: ["data"] }, { context: s.context });
  const slow = await s.watch(watcher.id, { rateCap: 1 });
  await s.personWrites();
  const made = await s.scheduler.tick();
  expect(made).toHaveLength(3);
  const clerkJob = (await s.context.db.select().from(runs).where(eq(runs.triggerId, s.clerkTrigger.id)))[0]!;
  await s.jobsWrite([clerkJob.id]);
  // Paused at three Jobs before this write was claimed: it waits.
  expect(await s.scheduler.tick()).toEqual([]);
  expect(await s.unprocessed()).toHaveLength(1);
  // Approve once, so the Watcher's fire of the next write is deferred (its cap is used up), then decline.
  await s.engine.answer((await s.pendingApproval())[0]!.id, approve, by(s));
  const next = await s.scheduler.tick();
  expect(next).toHaveLength(1);
  expect((await s.context.db.select().from(eventFires).where(eq(eventFires.triggerId, slow.id))).map((f) => f.status)).toEqual(["started", "deferred"]);
  await s.jobsWrite(next);
  const late = await s.scheduler.tick();
  expect(late).toHaveLength(1);
  await pauseBy(s, late[0]!);
  await s.jobsWrite(late);
  const [asked] = await s.pendingApproval();
  const going = (await s.context.db.select().from(runs).where(inArray(runs.status, ["running", "waiting"]))).map((r) => r.id);
  const sessions = (await s.context.db.select().from(stepRuns).where(inArray(stepRuns.runId, going))).map((st) => st.sessionId).filter((id): id is string => !!id);

  await s.engine.answer(asked!.id, decline, by(s));
  expect(await s.rootOf(made[0]!)).toMatchObject({ state: "stopped" });
  const jobs = await s.context.db.select().from(runs);
  expect(jobs.every((r) => r.status === "failed" && r.error === STOPPED)).toBe(true);
  expect(s.adapter.stops.sort()).toEqual(sessions.sort());
  expect(await s.unprocessed()).toEqual([]);
  const fires = await s.context.db.select().from(eventFires).where(eq(eventFires.triggerId, slow.id));
  expect(fires[0]).toMatchObject({ status: "started" });
  expect(fires.length).toBeGreaterThan(1);
  for (const f of fires.slice(1)) expect(f).toMatchObject({ status: "stopped", message: "Stopped at a checkpoint", runId: null });
  expect(await s.scheduler.tick()).toEqual([]);
  // Its Approval's events, and those of what its stopped Jobs asked, start nothing either.
  expect(await s.context.db.select().from(events).where(isNull(events.processedAt))).toEqual([]);

  // A reconnect and a restart replay nothing of it.
  const before = s.adapter.all;
  await s.engine.reconcile(s.runnerId, sessions);
  const restarted = new FakeAdapter();
  const engine2 = new Engine(s.context.db, restarted);
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  await engine2.reconcile(s.runnerId, []);
  expect(s.adapter.all).toBe(before);
  expect(restarted.all).toBe(0);
});

test("a chat counts: its start is a root, and each message of the owner one of its own, asked in the chat", async () => {
  const s = await setup(1);
  const assistant = await call(router.agents.create, { name: "Assistant", harnessId: s.harness.id, systemPrompt: "", bundles: ["data"] }, { context: s.context });
  const chat = await call(router.triggers.create, { agentId: assistant.id, name: "Chat", instructions: "", config: { kind: "manual", placement: "chat" } }, { context: s.context });
  // At a checkpoint of one Job, the chat's own start reaches it: its session waits, and so does a message.
  const runId = await s.engine.startJob(chat.id, s.context.ownerId);
  expect(s.adapter.starts).toEqual([]);
  await s.engine.sendChat(runId, "Hello");
  expect(s.adapter.all).toBe(0);
  const [first] = await s.pendingApproval();
  expect(first).toMatchObject({ runId, placement: "notifications" });
  await s.engine.answer(first!.id, approve, by(s));
  expect(s.adapter.starts).toHaveLength(1);
  await vi.waitFor(() => expect(s.adapter.sent.map(([, text]) => text)).toEqual(["Hello"]));

  // The next message is a root of its own: the Jobs its turn leads to count against it.
  await s.context.db.update(workspaceSettings).set({ checkpoint: 2 }).where(eq(workspaceSettings.ownerId, s.context.ownerId));
  await s.engine.sendChat(runId, "Update Ada");
  const message = await s.rootOf(runId);
  expect(message).toMatchObject({ kind: "chat", jobs: 0, runId });
  await s.jobsWrite([runId]);
  const made = await s.scheduler.tick();
  expect(made).toHaveLength(2);
  expect(await s.rootOf(made[0]!)).toMatchObject({ id: message.id, jobs: 2, state: "paused" });
  const chatStep = await s.sessionOf(runId);
  const [asked] = await s.pendingApproval();
  expect(asked).toMatchObject({ runId, stepRunId: chatStep.id, placement: "chat", rootId: message.id });
  // While it waits, a message to the chat's session sends nothing, and goes once approved.
  const before = s.adapter.sent.length;
  await s.engine.sendChat(runId, "And Bob?");
  expect(s.adapter.sent).toHaveLength(before);
  expect((await s.rootOf(runId)).id).toBe(message.id);
  await s.engine.answer(asked!.id, approve, by(s));
  expect(s.adapter.sent.slice(before).map(([, text]) => text)).toEqual(["And Bob?"]);
});

test("while paused, an answer to a waiting Question is kept, and goes once approved", async () => {
  const s = await setup(3);
  await s.personWrites();
  const made = await s.scheduler.tick();
  const step = await s.sessionOf(made[0]!);
  await s.emit(step.sessionId!, { type: "question", questionId: "rq_1", payload: { kind: "confirm-outputs", values: {} } });
  await pauseBy(s, made[1]!);
  const [question] = await s.context.db.select().from(questions).where(and(eq(questions.stepRunId, step.id), isNull(questions.rootId)));
  await s.engine.answer(question!.id, { kind: "confirm-outputs", confirmed: true }, by(s));
  expect(s.adapter.answers).toEqual([]);
  expect(await s.sessionOf(made[0]!)).toMatchObject({ working: false, queuedAt: null, pendingAction: { kind: "deliver" } });
  await s.engine.answer((await s.pendingApproval())[0]!.id, approve, by(s));
  expect(s.adapter.answers).toEqual([[step.sessionId, "rq_1", { kind: "confirm-outputs", confirmed: true }]]);
});

test("while paused, a runner's reconnect resumes nothing; the resume goes once approved", async () => {
  const s = await setup(3);
  await s.personWrites();
  const made = await s.scheduler.tick();
  await pauseBy(s, made[0]!);
  const starts = s.adapter.starts.length;
  // The runner comes back without the sessions: lost, they would resume.
  await s.engine.reconcile(s.runnerId, []);
  expect(s.adapter.starts).toHaveLength(starts);
  for (const runId of made) expect(await s.sessionOf(runId)).toMatchObject({ working: false, pendingAction: { kind: "resume" } });
  await s.engine.answer((await s.pendingApproval())[0]!.id, approve, by(s));
  // The two resume; the Job made at the checkpoint starts.
  const again = s.adapter.starts.slice(starts).map((x) => x.start.sessionId);
  const sessions = await Promise.all(made.map(async (runId) => (await s.sessionOf(runId)).sessionId!));
  for (const id of sessions) expect(again).toContain(id);
  expect(again).toHaveLength(3);
});

test("while paused, a step handed a slot starts nothing, nor does a restart; it starts once approved", async () => {
  // One slot: the second Job queues behind the first.
  const s = await setup(3, 1);
  await s.personWrites();
  const made = await s.scheduler.tick();
  expect(s.adapter.starts).toHaveLength(1);
  const [working, queued] = await Promise.all(made.map((runId) => s.sessionOf(runId)));
  const waiting = working!.sessionId ? queued! : working!;
  const first = working!.sessionId ? working! : queued!;
  expect(waiting.queuedAt).not.toBeNull();
  await pauseBy(s, first.runId);
  // The first Job finishes: its slot is handed to the queued one, whose root is paused.
  await s.emit(first.sessionId!, { type: "result", text: "Done." });
  expect(s.adapter.starts).toHaveLength(1);
  expect(await s.context.db.select().from(stepRuns).where(eq(stepRuns.id, waiting.id))).toMatchObject([{ working: false, queuedAt: null, status: "pending" }]);
  const restarted = new FakeAdapter();
  const engine2 = new Engine(s.context.db, restarted);
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  expect(restarted.starts).toEqual([]);
  await s.engine.answer((await s.pendingApproval())[0]!.id, approve, by(s));
  // One slot: the queued Job starts; the one made at the checkpoint queues behind it.
  expect(s.adapter.starts).toHaveLength(2);
  expect(s.adapter.starts[1]!.start.sessionId).toBe((await s.context.db.select().from(stepRuns).where(eq(stepRuns.id, waiting.id)))[0]!.sessionId);
});

test("a long relay past depth 10 goes on", async () => {
  const s = await setup(100);
  await s.personWrites();
  const made = await relay(s, 12);
  expect(made.length).toBeGreaterThanOrEqual(26);
  const deepest = Math.max(...(await s.context.db.select({ cause: runs.cause }).from(runs)).map((r) => r.cause?.depth ?? 0));
  expect(deepest).toBeGreaterThan(10);
  expect(await s.approvals()).toEqual([]);
});

test("a root approved just before the process stopped hands back what it held on the next start", async () => {
  const s = await setup(3);
  await s.personWrites();
  const made = await s.scheduler.tick();
  await pauseBy(s, made[0]!);
  await s.engine.reconcile(s.runnerId, []);
  const starts = s.adapter.starts.length;
  // The answer committed, and the process stopped before handing anything back.
  const root = await s.rootOf(made[0]!);
  await s.context.db.update(roots).set({ state: "going", countedFrom: root.jobs }).where(eq(roots.id, root.id));
  const restarted = new FakeAdapter();
  const engine2 = new Engine(s.context.db, restarted);
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  const sessions = await Promise.all(made.map(async (runId) => (await s.sessionOf(runId)).sessionId!));
  for (const id of sessions) expect(restarted.starts.map((x) => x.start.sessionId)).toContain(id);
  expect(s.adapter.starts).toHaveLength(starts);
});

test("while paused, a slot handed to a queued answer goes back: nothing is sent, and other work isn't held up", async () => {
  const s = await setup(3, 2);
  await s.personWrites();
  const made = await s.scheduler.tick();
  const [a, b] = await Promise.all(made.map((runId) => s.sessionOf(runId)));
  // B asks, and its answer queues behind A once the harness has one slot.
  await s.emit(b!.sessionId!, { type: "question", questionId: "rq_b", payload: { kind: "confirm-outputs", values: {} } });
  await s.context.db.update(harnesses).set({ maxWorking: 1 }).where(eq(harnesses.id, s.harness.id));
  const [asked] = await s.context.db.select().from(questions).where(eq(questions.stepRunId, b!.id));
  await s.engine.answer(asked!.id, { kind: "confirm-outputs", confirmed: true }, by(s));
  expect(await s.sessionOf(b!.runId)).toMatchObject({ working: false, pendingAction: { kind: "deliver" } });
  expect((await s.sessionOf(b!.runId)).queuedAt).not.toBeNull();
  await pauseBy(s, a!.runId);
  // A finishes: its slot is handed to B, whose root is paused: B gives it back at once.
  await s.emit(a!.sessionId!, { type: "result", text: "Done." });
  expect(await s.sessionOf(b!.runId)).toMatchObject({ working: false, queuedAt: null, pendingAction: { kind: "deliver" } });
  expect(s.adapter.answers).toEqual([]);
  await s.engine.answer((await s.pendingApproval())[0]!.id, approve, by(s));
  await vi.waitFor(() => expect(s.adapter.answers.map(([session]) => session)).toEqual([b!.sessionId]));
});
