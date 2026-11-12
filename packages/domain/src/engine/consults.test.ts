import { call } from "@orpc/server";
import type { Answer, HarnessEvent } from "@dispand/runner-protocol";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { agentConsults, agents, events, questions, roots, runs, stepRuns } from "../db/schema.ts";
import { takeApproval } from "../platform/approvals.ts";
import { jobScope, reachable } from "../questions/inbox-scope.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { INTERACTION } from "../triggers/model.ts";
import { CONSULTED_STOPPED, FLAGGED, IN_CHAIN, NOT_LISTED } from "./consults.ts";
import { answerText, Engine, EngineError, STOPPED } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { JOB_STEP } from "./job-def.ts";
import { ROOT_STOPPED } from "./roots.ts";

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
}

/** Three agents on one runner harness: Asker may consult Expert, Expert may consult Asker and Third. */
async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = (name: string, description = "") => call(router.agents.create, { name, description, harnessId: harness.id, systemPrompt: "" }, { context });
  const third = await agent("Third");
  const asker = await agent("Asker");
  const expert = await agent("Expert", "Knows the answers");
  /** What a person sets on the agent's page (the procedure is Task 1's, tested there). */
  const list = async (agentId: string, entries: string[], ask = false) => {
    await context.db.delete(agentConsults).where(eq(agentConsults.agentId, agentId));
    if (entries.length) await context.db.insert(agentConsults).values(entries.map((id) => ({ agentId, consultedId: id, ask })));
  };
  const set = (agentId: string, values: Partial<typeof agents.$inferInsert>) => context.db.update(agents).set(values).where(eq(agents.id, agentId));
  await list(asker.id, [expert.id]);
  await list(expert.id, [asker.id, third.id]);
  const trigger = await call(router.triggers.create, { agentId: asker.id, name: "Go", instructions: "Find out.", config: { kind: "manual", placement: "button" } }, { context });
  const adapter = new FakeAdapter();
  let engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  let seq = 0;
  /** An event of the session, from the runner it runs on. */
  const emit = async (sessionId: string, event: HarnessEvent) => {
    const [step] = await context.db.select({ runnerId: stepRuns.runnerId }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    await engine.onHarnessEvent(sessionId, event, { runnerId: step!.runnerId!, seq: ++seq });
  };
  const stepOf = async (runId: string) => (await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, JOB_STEP))))[0]!;
  /** The run's session once it was started. */
  const sessionOf = (runId: string) =>
    vi.waitFor(async () => {
      const step = await stepOf(runId);
      if (!step.sessionId || !adapter.starts.some((s) => s.start.sessionId === step.sessionId)) throw new Error("not started");
      return step.sessionId;
    });
  const start = async () => {
    const runId = await engine.startJob(trigger.id, context.ownerId);
    return { runId, sessionId: await sessionOf(runId) };
  };
  let asked = 0;
  /** The session asks to consult `agentId`; returns the consult row. */
  const consult = async (sessionId: string, agentId: string, question = "What is the answer?") => {
    const questionId = `rq${++asked}`;
    await emit(sessionId, { type: "question", questionId, payload: { kind: "consult", agentId, question } });
    const [row] = await context.db.select().from(questions).where(eq(questions.runnerQuestionId, questionId));
    return row!;
  };
  /** The consulted run of a consult row, once made. */
  const consulted = (questionId: string) =>
    vi.waitFor(async () => {
      const [row] = await context.db.select().from(questions).where(eq(questions.id, questionId));
      if (!row?.consultRunId) throw new Error("no consulted run yet");
      return row.consultRunId;
    });
  const question = async (id: string) => (await context.db.select().from(questions).where(eq(questions.id, id)))[0]!;
  const run = async (id: string) => (await context.db.select().from(runs).where(eq(runs.id, id)))[0]!;
  /** What the session was answered, once it was. */
  const answered = (sessionId: string) =>
    vi.waitFor(() => {
      const got = adapter.answers.filter(([s]) => s === sessionId);
      if (got.length === 0) throw new Error("not answered yet");
      return got.map(([, , a]) => a);
    });
  /** A new engine on the same database: a restart. */
  const restart = async () => {
    await engine.stop();
    engine = new Engine(context.db, adapter);
    await engine.recover();
    return engine;
  };
  return { context, runnerId, harness, third, asker, expert, list, set, trigger, adapter, engine: () => engine, emit, start, consult, consulted, question, run, answered, stepOf, sessionOf, restart };
}

test("a Job consults an agent: a Job of that agent answers, and the asker goes on with its answer", async () => {
  const s = await setup();
  const asker = await s.start();
  const q = await s.consult(asker.sessionId, s.expert.id, "Which plan?");
  expect(q).toMatchObject({ kind: "consult", status: "pending" });
  // The asker waits, holding no slot.
  expect(await s.stepOf(asker.runId)).toMatchObject({ status: "waiting", working: false });
  const consultedId = await s.consulted(q.id);
  const job = await s.run(consultedId);
  // A Job of the consulted agent, with no trigger: its firing is the consult, its cause the asker, in the asker's root.
  expect(job).toMatchObject({ source: "agent", agentId: s.expert.id, triggerId: null, rootId: (await s.run(asker.runId)).rootId, trigger: { type: "consult", questionId: q.id } });
  expect(job.cause).toMatchObject({ kind: "consult", questionId: q.id, jobId: asker.runId, depth: 1 });
  // Its prompt holds the question, the asking agent and Job, and nothing of the asker's work.
  const sessionId = await s.sessionOf(consultedId);
  const prompt = s.adapter.starts.find((x) => x.start.sessionId === sessionId)!.start.prompt;
  expect(prompt).toContain("Which plan?");
  expect(prompt).toContain(`Asker (Job ${asker.runId}) consults you`);
  expect(prompt).not.toContain("Find out.");
  await s.emit(sessionId, { type: "result", text: "Plan B." });
  expect(await s.answered(asker.sessionId)).toEqual([{ kind: "consult", outcome: "answered", text: "Plan B." }]);
  // Recorded as the consulted agent's answer, by its Job; said so in words.
  const done = await s.question(q.id);
  expect(done).toMatchObject({ status: "answered", answeredBy: { type: "agent", agentId: s.expert.id, runId: consultedId, name: "Expert" } });
  expect(answerText(done)).toBe("Answer from the agent Expert:\n\nPlan B.");
  expect(await s.stepOf(asker.runId)).toMatchObject({ status: "running" });
});

test("each refusal at the call answers the consult with its reason and makes no Job", async () => {
  const s = await setup();
  const refused = async (agentId: string) => {
    const asker = await s.start();
    const q = await s.consult(asker.sessionId, agentId);
    const [answer] = await s.answered(asker.sessionId);
    expect((await s.question(q.id)).consultRunId).toBeNull();
    await s.engine().stopRun(asker.runId);
    return (answer as Extract<Answer, { kind: "consult" }>).text;
  };
  // Not on the list.
  expect(await refused(s.third.id)).toBe(NOT_LISTED);
  // Itself.
  expect(await refused(s.asker.id)).toBe(NOT_LISTED);
  // Flagged: the owner's Approval of it isn't built yet.
  await s.list(s.asker.id, [s.expert.id], true);
  expect(await refused(s.expert.id)).toBe(FLAGGED);
  // Taken off the agent since its Job started: the snapshot isn't enough.
  await s.list(s.asker.id, [s.expert.id]);
  const asker = await s.start();
  await s.list(s.asker.id, []);
  await s.consult(asker.sessionId, s.expert.id);
  expect(await s.answered(asker.sessionId)).toEqual([{ kind: "consult", outcome: "failed", text: NOT_LISTED }]);
  // One side of `configure`: the pair no longer passes.
  await s.list(s.asker.id, [s.expert.id]);
  await s.set(s.expert.id, { bundles: ["configure"] });
  expect(await refused(s.expert.id)).toContain("never consult each other");
  // A root stopped meanwhile.
  await s.set(s.expert.id, { bundles: [] });
  const late = await s.start();
  await s.context.db.update(roots).set({ state: "stopped" }).where(eq(roots.id, (await s.run(late.runId)).rootId!));
  // (Nothing of a stopped root works again: the answer is recorded, never sent.)
  const stopped = await s.consult(late.sessionId, s.expert.id);
  expect((await s.question(stopped.id)).answer).toEqual({ kind: "consult", outcome: "failed", text: ROOT_STOPPED });
  // No Job was ever made of the agents consulted.
  expect(await s.context.db.select().from(runs).where(eq(runs.agentId, s.expert.id))).toEqual([]);
});

test("an agent higher in the chain of consults can't be consulted: A asks B, B asks A is refused", async () => {
  const s = await setup();
  const asker = await s.start();
  const q = await s.consult(asker.sessionId, s.expert.id);
  const expertSession = await s.sessionOf(await s.consulted(q.id));
  await s.consult(expertSession, s.asker.id);
  expect(await s.answered(expertSession)).toEqual([{ kind: "consult", outcome: "failed", text: IN_CHAIN }]);
});

test("a consulted Job that fails or is stopped gives the asker that error", async () => {
  const s = await setup();
  const first = await s.start();
  const q1 = await s.consult(first.sessionId, s.expert.id);
  await s.emit(await s.sessionOf(await s.consulted(q1.id)), { type: "error", message: "the model is gone" });
  expect(await s.answered(first.sessionId)).toEqual([{ kind: "consult", outcome: "failed", text: "The consulted Job failed: the model is gone" }]);

  const second = await s.start();
  const q2 = await s.consult(second.sessionId, s.expert.id);
  await s.engine().stopRun(await s.consulted(q2.id));
  expect(await s.answered(second.sessionId)).toEqual([{ kind: "consult", outcome: "failed", text: CONSULTED_STOPPED }]);
});

test("stopping the asker stops its consulted Job and the one that one consults, and their sessions", async () => {
  const s = await setup();
  const asker = await s.start();
  const q = await s.consult(asker.sessionId, s.expert.id);
  const expertRun = await s.consulted(q.id);
  const expertSession = await s.sessionOf(expertRun);
  const q2 = await s.consult(expertSession, s.third.id);
  const thirdRun = await s.consulted(q2.id);
  const thirdSession = await s.sessionOf(thirdRun);
  await s.engine().stopRun(asker.runId);
  for (const id of [asker.runId, expertRun, thirdRun]) expect(await s.run(id)).toMatchObject({ status: "failed", error: STOPPED });
  expect((await s.question(q.id)).status).toBe("expired");
  expect((await s.question(q2.id)).status).toBe("expired");
  await vi.waitFor(() => expect(s.adapter.stops).toEqual(expect.arrayContaining([asker.sessionId, expertSession, thirdSession])));
  // Nothing of the chain answered anyone.
  expect(s.adapter.answers).toEqual([]);
});

test("a resumed session that asks again ends the consult of the session it replaced: its consulted Job stops", async () => {
  const s = await setup();
  const asker = await s.start();
  const q = await s.consult(asker.sessionId, s.expert.id);
  const expertRun = await s.consulted(q.id);
  // The runner lost the session: it resumes, and its consult is orphaned (its answer would go as words).
  await s.emit(asker.sessionId, { type: "error", message: "the session is not running on this runner" });
  await vi.waitFor(async () => expect((await s.question(q.id)).orphaned).toBe(true));
  // The resumed session asks again: the first consult ends, and its Job with it.
  const again = await s.consult(asker.sessionId, s.expert.id);
  expect((await s.question(q.id)).status).toBe("expired");
  expect(await s.run(expertRun)).toMatchObject({ status: "failed", error: STOPPED });
  expect(await s.consulted(again.id)).not.toBe(expertRun);
});

test("a session lost while it waits on a consult gets the answer as words in its resume", async () => {
  const s = await setup();
  const asker = await s.start();
  const q = await s.consult(asker.sessionId, s.expert.id);
  const expertSession = await s.sessionOf(await s.consulted(q.id));
  await s.emit(asker.sessionId, { type: "error", message: "the session is not running on this runner" });
  await vi.waitFor(async () => expect((await s.question(q.id)).orphaned).toBe(true));
  const resumes = s.adapter.starts.length;
  await s.emit(expertSession, { type: "result", text: "Plan C." });
  // Orphaned: it goes as a message, and says who answered.
  await vi.waitFor(() => expect(s.adapter.sent).toContainEqual([asker.sessionId, "Answer from the agent Expert:\n\nPlan C."]));
  expect(s.adapter.starts.length).toBe(resumes);
});

test("a right taken back after the answer was recorded and before it reached the asker: the asker gets the reason", async () => {
  const s = await setup();
  // The asker's harness is full when the answer comes: it queues to get it.
  const other = await s.start();
  const asker = await s.start();
  const q = await s.consult(asker.sessionId, s.expert.id);
  const expertSession = await s.sessionOf(await s.consulted(q.id));
  await s.engine().setLimit(s.harness.id, 1);
  await s.emit(expertSession, { type: "result", text: "Plan D." });
  await vi.waitFor(async () => expect((await s.question(q.id)).status).toBe("answered"));
  expect(await s.stepOf(asker.runId)).toMatchObject({ queuedAt: expect.any(Date) });
  // The entry is taken off the asker's agent, then the slot frees.
  await s.list(s.asker.id, []);
  await s.engine().stopRun(other.runId);
  expect(await s.answered(asker.sessionId)).toEqual([{ kind: "consult", outcome: "failed", text: NOT_LISTED }]);
  expect((await s.question(q.id)).answer).toEqual({ kind: "consult", outcome: "failed", text: NOT_LISTED });
});

test("a consult is no Inbox item: no list, count, answer, inbox tool, approval or interaction event reaches it", async () => {
  const s = await setup();
  await s.set(s.third.id, { bundles: ["inbox"] });
  const asker = await s.start();
  const q = await s.consult(asker.sessionId, s.expert.id);
  const context = s.context;
  expect(await call(router.questions.list, { status: "all" }, { context })).toEqual([]);
  expect(await call(router.questions.count, undefined, { context })).toEqual({ count: 0 });
  await expect(call(router.questions.answer, { questionId: q.id, answer: { kind: "consult", outcome: "answered", text: "Me" } } as never, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(s.engine().answer(q.id, { kind: "consult", outcome: "answered", text: "Me" }, { type: "user", userId: context.ownerId })).rejects.toBeInstanceOf(EngineError);
  // An `inbox` agent's Job can't reach it.
  const thirdTrigger = await call(router.triggers.create, { agentId: s.third.id, name: "Go", instructions: "Read.", config: { kind: "manual", placement: "button" } }, { context });
  const reader = await s.engine().startJob(thirdTrigger.id, context.ownerId);
  const scope = await jobScope(context.db, { runId: reader, ownerId: context.ownerId, agentId: s.third.id });
  expect(await reachable(context.db, scope!, q.id)).toBe(false);
  // No server-side call takes it as an approval.
  expect(await takeApproval(context.db, { runId: asker.runId, ownerId: context.ownerId, agentId: s.asker.id }, "consult", { agentId: s.expert.id })).toBe(false);
  // Asked, answered or expired: no interaction event.
  await s.emit(await s.sessionOf(await s.consulted(q.id)), { type: "result", text: "Done." });
  await s.answered(asker.sessionId);
  const second = await s.consult(asker.sessionId, s.expert.id);
  await s.engine().stopRun(asker.runId);
  expect((await s.question(second.id)).status).toBe("expired");
  const interactions = await context.db.select().from(events).where(eq(events.tableId, INTERACTION));
  expect(interactions.filter((e) => e.rowId === q.id || e.rowId === second.id)).toEqual([]);
  // Still none listed, with every state.
  expect(await call(router.questions.list, { status: "all" }, { context })).toEqual([]);
});

test("two Jobs consult one agent whose harness runs one at a time: two Jobs of it, each answer to its own asker", async () => {
  const s = await setup();
  const { runnerId } = await call(router.runners.create, { name: "Other" }, { context: s.context });
  const single = asCli(await call(router.harnesses.create, { name: "Single", runnerId, kind: "claude-code", permissionMode: "default" }, { context: s.context }));
  await s.engine().setLimit(single.id, 1);
  await s.set(s.expert.id, { harnessId: single.id });
  const one = await s.start();
  const two = await s.start();
  const q1 = await s.consult(one.sessionId, s.expert.id, "First?");
  const q2 = await s.consult(two.sessionId, s.expert.id, "Second?");
  const r1 = await s.consulted(q1.id);
  const r2 = await s.consulted(q2.id);
  expect(r1).not.toBe(r2);
  // One works, the other is queued (whichever started first).
  const queued = await vi.waitFor(async () => {
    const steps = [await s.stepOf(r1), await s.stepOf(r2)];
    const waiting = steps.filter((x) => x.queuedAt);
    if (waiting.length !== 1) throw new Error("not one queued yet");
    return waiting[0]!.runId;
  });
  const [first, then] = queued === r2 ? [r1, r2] : [r2, r1];
  expect(await s.stepOf(then)).toMatchObject({ sessionId: null });
  await s.emit(await s.sessionOf(first), { type: "result", text: first === r1 ? "One." : "Two." });
  await s.emit(await s.sessionOf(then), { type: "result", text: then === r1 ? "One." : "Two." });
  expect(await s.answered(one.sessionId)).toEqual([{ kind: "consult", outcome: "answered", text: "One." }]);
  expect(await s.answered(two.sessionId)).toEqual([{ kind: "consult", outcome: "answered", text: "Two." }]);
});

test("restarts: a consult with no Job yet is opened, one whose Job ended is answered, once", async () => {
  const s = await setup();
  // Asked while its root was paused: pending with no Job; the root went on before the process could open it.
  const asker = await s.start();
  const rootId = (await s.run(asker.runId)).rootId!;
  await s.context.db.update(roots).set({ state: "paused" }).where(eq(roots.id, rootId));
  const q = await s.consult(asker.sessionId, s.expert.id);
  expect(await s.question(q.id)).toMatchObject({ status: "pending", consultRunId: null });
  await s.context.db.update(roots).set({ state: "going" }).where(eq(roots.id, rootId));
  await s.restart();
  const consultedId = await s.consulted(q.id);
  // The consulted Job ended, and the process stopped before the consult was answered.
  const sessionId = await s.sessionOf(consultedId);
  await s.emit(sessionId, { type: "result", text: "Plan E." });
  await s.answered(asker.sessionId);
  await s.context.db.update(questions).set({ status: "pending", answer: null, answeredAt: null, answeredBy: null, deliveredAt: null }).where(eq(questions.id, q.id));
  s.adapter.answers = [];
  await s.restart();
  expect(await s.answered(asker.sessionId)).toEqual([{ kind: "consult", outcome: "answered", text: "Plan E." }]);
  await s.restart();
  // One consulted Job, one answer.
  expect(await s.context.db.select().from(runs).where(and(eq(runs.agentId, s.expert.id)))).toHaveLength(1);
  expect(s.adapter.answers).toHaveLength(1);
  expect(await s.context.db.select().from(agentConsults)).toHaveLength(3);
});
