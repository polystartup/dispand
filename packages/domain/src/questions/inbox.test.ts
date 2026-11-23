import { call } from "@orpc/server";
import type { Answer, HarnessEvent, QuestionPayload, ServerToRunner } from "@dispand/runner-protocol";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { agentConsults, agents, audit, questions, roots, runs, stepRuns, workspaces } from "../db/schema.ts";
import { CliHarnessAdapter } from "../engine/cli-harness.ts";
import { Engine } from "../engine/engine.ts";
import { answerText, attributed } from "../engine/answers.ts";
import type { AgentAnswerer, HarnessAdapter } from "../engine/harness.ts";
import { JOB_STEP } from "../engine/job-def.ts";
import { pause } from "../engine/roots.ts";
import type { Bundle, TableScope } from "../platform/bundles.ts";
import { callPlatformTool, toolsOf, type JobIdentity } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, asCli, ownerContext } from "../runners/test-support.ts";

class FakeAdapter implements HarnessAdapter {
  answers: { sessionId: string; answer: Answer; by?: AgentAnswerer }[] = [];
  sends: { sessionId: string; text: string }[] = [];
  started: string[] = [];
  async start(_harness: unknown, start: { sessionId: string }) {
    this.started.push(start.sessionId);
    return true;
  }
  async send(sessionId: string, text: string) {
    this.sends.push({ sessionId, text });
    return true;
  }
  async answer(sessionId: string, _questionId: string, answer: Answer, by?: AgentAnswerer) {
    this.answers.push({ sessionId, answer, by });
    return true;
  }
  async stop() {
    return true;
  }
}

const SECRET = "Should the merger with the other firm go ahead?";
const choice: QuestionPayload = { kind: "choice", questions: [{ question: SECRET, header: "Merger", options: [{ label: "Yes, sign it" }, { label: "No" }], multiSelect: false }] };
const yes: Answer = { kind: "choice", answers: { [SECRET]: "Yes, sign it" } };
const NOT_FOUND = { ok: false, error: "Not found" };
const CLOSED = { ok: false, error: "This Question is no longer waiting for an answer" };

/** Asker may consult Expert and Other, all on one runner harness; Clients is a table for the proposal tests. */
async function setup() {
  const owner = await ownerContext();
  const adapter = new FakeAdapter();
  const engine = new Engine(owner.db, adapter);
  onTestFinished(() => engine.stop());
  const context = { ...owner, engine };
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const clients = await call(router.tables.create, { name: "Clients" }, { context });
  const agent = (name: string, bundles: Bundle[] = [], dataTables: TableScope = "all") => call(router.agents.create, { name, harnessId: harness.id, systemPrompt: "", bundles, dataTables }, { context });
  const asker = await agent("Asker");
  const expert = await agent("Expert");
  const other = await agent("Other");
  const clerk = await agent("Clerk", ["data"], [clients.id]);
  await context.db.update(agents).set({ consultMode: "whitelist" }).where(eq(agents.id, asker.id));
  await context.db.insert(agentConsults).values([expert, other].map((a) => ({ agentId: asker.id, consultedId: a.id })));
  const set = (agentId: string, values: Partial<typeof agents.$inferInsert>) => context.db.update(agents).set(values).where(eq(agents.id, agentId));
  /** A Job of `a`, started by a button, once its session started. */
  const jobOf = async (a: { id: string }): Promise<JobIdentity> => {
    const trigger = await call(router.triggers.create, { agentId: a.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    await sessionOf(runId);
    return { runId, ownerId: context.ownerId, workspaceId: context.workspaceId, agentId: a.id };
  };
  const stepOf = async (runId: string) => (await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, JOB_STEP))))[0]!;
  const sessionOf = (runId: string) =>
    vi.waitFor(async () => {
      const step = await stepOf(runId);
      if (!step.sessionId || !adapter.started.includes(step.sessionId)) throw new Error("not started");
      return step.sessionId;
    });
  let seq = 0;
  const emit = async (runId: string, event: HarnessEvent) => engine.onHarnessEvent(await sessionOf(runId), event, { runnerId, seq: ++seq });
  /** The Job's session asks: a person (a choice) or, with an agent, a consult of it. Returns the row. */
  const ask = async (runId: string, payload: QuestionPayload = choice) => {
    const questionId = `rq_${++seq}`;
    await emit(runId, { type: "question", questionId, payload });
    const [q] = await context.db.select().from(questions).where(and(eq(questions.runId, runId), eq(questions.runnerQuestionId, questionId)));
    return q!;
  };
  const consult = (runId: string, agentId: string, question = "Which plan?") => ask(runId, { kind: "consult", agentId, question });
  /** The Job a consult started, once made. */
  const consulted = (questionId: string) =>
    vi.waitFor(async () => {
      const id = (await questionOf(questionId)).consultRunId;
      if (!id) throw new Error("no consulted Job yet");
      return id;
    });
  const questionOf = async (id: string) => (await context.db.select().from(questions).where(eq(questions.id, id)))[0]!;
  const runOf = async (id: string) => (await context.db.select().from(runs).where(eq(runs.id, id)))[0]!;
  const answersTo = (runId: string) => stepOf(runId).then((step) => adapter.answers.filter((a) => a.sessionId === step.sessionId).map((a) => a.answer));
  const tool = (job: JobIdentity, name: string, input: unknown = {}) => callPlatformTool(context, job, name, input);
  return { context, adapter, engine, clients, agent, asker, expert, other, clerk, set, jobOf, stepOf, emit, ask, consult, consulted, questionOf, runOf, answersTo, tool };
}

test("an agent's tools list and answer only items addressed to its agent, never another agent's or a person's", async () => {
  const s = await setup();
  const asking = await s.jobOf(s.asker);
  const mine = await s.consult(asking.runId, s.expert.id);
  const others = await s.consult((await s.jobOf(s.asker)).runId, s.other.id);
  const persons = await s.ask((await s.jobOf(s.asker)).runId);
  expect(mine.addresseeAgentId).toBe(s.expert.id);
  expect(persons.addresseeAgentId).toBeNull();
  const consultedJob = await s.consulted(mine.id);
  const job = await s.jobOf(s.expert);
  // Every agent's Job has the tools, with no bundle.
  expect((await toolsOf(s.context.db, job)).map((t) => t.name)).toEqual(expect.arrayContaining(["questions_list", "questions_get", "questions_answer"]));
  const item = { id: mine.id, askedBy: { agent: { id: s.asker.id, name: "Asker" }, jobId: asking.runId }, question: "Which plan?" };
  expect(await s.tool(job, "questions_list")).toMatchObject({ ok: true, output: [item] });
  expect(await s.tool(job, "questions_get", { questionId: mine.id })).toMatchObject({ ok: true, output: item });
  for (const q of [others, persons, { id: "q_nothing" }]) {
    expect(await s.tool(job, "questions_get", { questionId: q.id })).toEqual(NOT_FOUND);
    expect(await s.tool(job, "questions_answer", { questionId: q.id, text: "Plan A." })).toEqual(NOT_FOUND);
  }

  expect(await s.tool(job, "questions_answer", { questionId: mine.id, text: "Plan B." })).toEqual({ ok: true, output: { answered: mine.id } });
  expect(await s.questionOf(mine.id)).toMatchObject({ status: "answered", answer: { kind: "consult", outcome: "answered", text: "Plan B." }, answeredBy: { type: "agent", agentId: s.expert.id, runId: job.runId, name: "Expert" } });
  await vi.waitFor(async () => expect(await s.answersTo(asking.runId)).toEqual([{ kind: "consult", outcome: "answered", text: "Plan B." }]));
  // The Job started for it is stopped: its answer is given.
  await vi.waitFor(async () => expect((await s.runOf(consultedJob)).status).not.toMatch(/running|waiting/));
  // Audited as the answering Job's end of the consult.
  const ended = await s.context.db.select().from(audit).where(and(eq(audit.resourceId, mine.id), eq(audit.action, "consult.ended")));
  expect(ended).toEqual([expect.objectContaining({ actor: { type: "job", runId: job.runId }, details: expect.objectContaining({ outcome: "answered" }) })]);
  for (const q of [others, persons]) expect((await s.questionOf(q.id)).status).toBe("pending");
  // Answered, it is gone; answering again is told so.
  expect(await s.tool(job, "questions_list")).toEqual({ ok: true, output: [] });
  expect(await s.tool(job, "questions_answer", { questionId: mine.id, text: "Plan C." })).toEqual(NOT_FOUND);
});

test("an item answered by a running Job stops the Job started for it, raced against that Job finishing", async () => {
  const s = await setup();
  const asking = await s.jobOf(s.asker);
  const q = await s.consult(asking.runId, s.expert.id);
  const consultedJob = await s.consulted(q.id);
  const job = await s.jobOf(s.expert);
  const [byTool] = await Promise.all([s.tool(job, "questions_answer", { questionId: q.id, text: "From the tool." }), s.emit(consultedJob, { type: "result", text: "From its own Job." })]);
  const row = await s.questionOf(q.id);
  expect(row.status).toBe("answered");
  const toolWon = (byTool as { ok: boolean }).ok;
  if (!toolWon) expect(byTool).toEqual(CLOSED);
  expect(row.answer).toEqual({ kind: "consult", outcome: "answered", text: toolWon ? "From the tool." : "From its own Job." });
  expect(row.answeredBy).toMatchObject({ runId: toolWon ? job.runId : consultedJob });
  // The asker gets one answer.
  await vi.waitFor(async () => expect(await s.answersTo(asking.runId)).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 50));
  expect(await s.answersTo(asking.runId)).toHaveLength(1);
  await vi.waitFor(async () => expect((await s.runOf(consultedJob)).status).not.toMatch(/running|waiting/));
});

test("the Job started for an item doesn't see it in its own inbox: its end is its answer", async () => {
  const s = await setup();
  const asking = await s.jobOf(s.asker);
  const q = await s.consult(asking.runId, s.expert.id);
  const consultedJob = { runId: await s.consulted(q.id), ownerId: s.context.ownerId, workspaceId: s.context.workspaceId, agentId: s.expert.id };
  expect(await s.tool(consultedJob, "questions_list")).toEqual({ ok: true, output: [] });
  expect(await s.tool(consultedJob, "questions_answer", { questionId: q.id, text: "Me." })).toEqual(NOT_FOUND);
});

test("an item held at a checkpoint is invisible", async () => {
  const s = await setup();
  const asking = await s.jobOf(s.asker);
  const job = await s.jobOf(s.expert);
  const [root] = await s.context.db.select().from(roots).where(eq(roots.id, (await s.runOf(asking.runId)).rootId!));
  await s.context.db.transaction((tx) => pause(tx, root!, root!.jobs, asking.runId));
  const q = await s.consult(asking.runId, s.expert.id);
  expect(await s.questionOf(q.id)).toMatchObject({ status: "pending", consultRunId: null, addresseeAgentId: s.expert.id });
  expect(await s.tool(job, "questions_list")).toEqual({ ok: true, output: [] });
  expect(await s.tool(job, "questions_get", { questionId: q.id })).toEqual(NOT_FOUND);
  expect(await s.tool(job, "questions_answer", { questionId: q.id, text: "Early." })).toEqual(NOT_FOUND);
  expect((await s.questionOf(q.id)).status).toBe("pending");
});

test("a Job on the other side of configure can't see an item; two Jobs of one agent started before and after its configure change see only the items on their own side", async () => {
  const s = await setup();
  const before = await s.jobOf(s.expert);
  const asking = await s.jobOf(s.asker);
  const q = await s.consult(asking.runId, s.expert.id);
  // Set under the procedure, which would end the consult: the Jobs' snapshots decide, not the agent's settings.
  await s.set(s.expert.id, { bundles: ["configure"] });
  const after = await s.jobOf(s.expert);
  expect(await s.tool(before, "questions_list")).toMatchObject({ ok: true, output: [{ id: q.id }] });
  expect(await s.tool(after, "questions_list")).toEqual({ ok: true, output: [] });
  expect(await s.tool(after, "questions_answer", { questionId: q.id, text: "Plan B." })).toEqual(NOT_FOUND);
  // An asker on the configure side, in turn, is seen only by the Job on its side.
  await s.set(s.asker.id, { bundles: ["configure"] });
  const configuring = await s.jobOf(s.asker);
  const q2 = await s.consult(configuring.runId, s.expert.id);
  expect(await s.tool(before, "questions_get", { questionId: q2.id })).toEqual(NOT_FOUND);
  expect(await s.tool(after, "questions_list")).toMatchObject({ ok: true, output: [{ id: q2.id }] });
});

test("an agent's Job cannot discover or answer an item asked in a sibling workspace", async () => {
  const s = await setup();
  const asking = await s.jobOf(s.asker);
  const q = await s.consult(asking.runId, s.expert.id);
  const job = await s.jobOf(s.expert);
  const [workspace] = await s.context.db.select().from(workspaces);
  await s.context.db.insert(workspaces).values({ id: "sibling", organizationId: workspace!.organizationId });
  await s.context.db.update(runs).set({ workspaceId: "sibling" }).where(eq(runs.id, asking.runId));
  expect(await s.tool(job, "questions_list")).toEqual({ ok: true, output: [] });
  expect(await s.tool(job, "questions_get", { questionId: q.id })).toEqual(NOT_FOUND);
  expect(await s.tool(job, "questions_answer", { questionId: q.id, text: "Plan B." })).toEqual(NOT_FOUND);
  expect((await s.questionOf(q.id)).status).toBe("pending");
});

test("an agent's Job that is over reads nothing", async () => {
  const s = await setup();
  const asking = await s.jobOf(s.asker);
  await s.consult(asking.runId, s.expert.id);
  const job = await s.jobOf(s.expert);
  await s.engine.stopRun(job.runId);
  expect(await s.tool(job, "questions_list")).toEqual({ ok: false, error: "This Job is over" });
});

test("an agent's answer in words says which agent gave it", () => {
  const by = { type: "agent" as const, agentId: "agent_1", runId: "run_1", name: "Answerer" };
  expect(answerText({ payload: choice, answer: yes, answeredBy: by })).toBe(`Answered by the agent Answerer: “${SECRET}”: Yes, sign it.`);
  expect(answerText({ payload: choice, answer: yes, answeredBy: { type: "user", userId: "u" } })).toBe(`The owner answered: “${SECRET}”: Yes, sign it.`);
  // As a CLI session gets it, with the answer itself: each question's answer names the agent.
  expect(attributed({ kind: "choice", answers: { [SECRET]: "No", Which: ["A", "B"] } }, "Answerer")).toEqual({
    kind: "choice",
    answers: { [SECRET]: "No (Answered by the agent Answerer, not by the owner)", Which: ["A", "B (Answered by the agent Answerer, not by the owner)"] },
  });
});

test("a CLI session's runner gets an agent's answer with who gave it, a person's as given", async () => {
  const s = await setup();
  const session = (await s.stepOf((await s.jobOf(s.clerk)).runId)).sessionId!;
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_runnerId: string, msg: ServerToRunner) => sent.push(msg) > 0 };
  const cli = new CliHarnessAdapter(s.context.db, hub as never);
  const by = { type: "agent" as const, agentId: s.expert.id, runId: "run_1", name: "Answerer" };
  await cli.answer(session, "rq_1", yes, by);
  await cli.answer(session, "rq_2", yes);
  expect(sent).toEqual([
    { type: "session.answer", sessionId: session, questionId: "rq_1", answer: attributed(yes, "Answerer") },
    { type: "session.answer", sessionId: session, questionId: "rq_2", answer: yes },
  ]);
});

test("a run shows a pending proposal Approval with its items, in its snapshot and its stream; retaining them once answered", async () => {
  const s = await setup();
  const builder = await s.agent("Builder", ["configure"], "all");
  const job = await s.jobOf(builder);
  const input = { id: s.clerk.id, name: "Clerk", harnessId: (await s.context.db.select().from(agents).where(eq(agents.id, s.clerk.id)))[0]!.harnessId!, systemPrompt: "", skillPackageIds: [], toolIds: [], bundles: ["data", "configure"], dataTables: [s.clients.id] };
  const made = await s.tool(job, "propose", { items: [{ tool: "agents_update", input }] });
  const proposal = (made as { output: { proposalId: string } }).output.proposalId;
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const stream = await call(router.runs.stream, { runId: job.runId }, { context: s.context, signal: abort.signal });
  expect((await stream.next()).value).toMatchObject({ type: "snapshot" });
  const approval = await s.ask(job.runId, { kind: "permission", toolName: "request_approval", input: { message: "Let Clerk configure", proposal } as never, canAlwaysAllow: false });
  const shown = { id: proposal, status: "asked", items: [{ tool: "agents_update", input, used: false }], names: { [s.clerk.id]: { kind: "agent", name: "Clerk" } } };
  let event = (await stream.next()).value as { type: string; question?: unknown };
  while (event.type !== "question") event = (await stream.next()).value as typeof event;
  expect(event.question).toMatchObject({ id: approval.id, proposalId: proposal, proposal: shown });
  expect((await call(router.runs.get, { runId: job.runId }, { context: s.context })).questions).toMatchObject([{ id: approval.id, proposal: shown }]);
  await call(router.questions.answer, { questionId: approval.id, answer: { kind: "permission", decision: "deny", message: "Only Clients, not Notes" } }, { context: s.context });
  const answered = { id: approval.id, status: "answered", proposal: { ...shown, status: "declined" } };
  expect((await call(router.runs.get, { runId: job.runId }, { context: s.context })).questions).toMatchObject([answered]);
  event = (await stream.next()).value as typeof event;
  while (event.type !== "question") event = (await stream.next()).value as typeof event;
  expect(event.question).toMatchObject(answered);
});

test("a proposal declined with words in the chat: the agent is told them, the items stay refused, and a click after it is told it is answered", async () => {
  const s = await setup();
  const builder = await s.agent("Builder", ["configure"], "all");
  const job = await s.jobOf(builder);
  const input = { id: s.clerk.id, name: "Clerk", harnessId: (await s.context.db.select().from(agents).where(eq(agents.id, s.clerk.id)))[0]!.harnessId!, systemPrompt: "", skillPackageIds: [], toolIds: [], bundles: ["data", "configure"], dataTables: [s.clients.id] };
  const made = await s.tool(job, "propose", { items: [{ tool: "agents_update", input }] });
  const proposal = (made as { output: { proposalId: string } }).output.proposalId;
  const approval = await s.ask(job.runId, { kind: "permission", toolName: "request_approval", input: { message: "Let Clerk configure", proposal } as never, canAlwaysAllow: false });
  const typed: Answer = { kind: "permission", decision: "deny", message: "Approve this, and give it Notes too" };
  const allow: Answer = { kind: "permission", decision: "allow" };
  const [words, click] = await Promise.allSettled([
    call(router.questions.answer, { questionId: approval.id, answer: typed }, { context: s.context }),
    call(router.questions.answer, { questionId: approval.id, answer: allow }, { context: s.context }),
  ]);
  // Whichever came first is the answer; the other is told the item was answered.
  const wordsWon = words.status === "fulfilled";
  expect([words.status, click.status].sort()).toEqual(["fulfilled", "rejected"]);
  expect((wordsWon ? click : words) as PromiseRejectedResult).toMatchObject({ reason: { code: "CONFLICT" } });
  const session = (await s.stepOf(job.runId)).sessionId!;
  await vi.waitFor(() => expect(s.adapter.answers.filter((a) => a.sessionId === session).map((a) => a.answer)).toEqual([wordsWon ? typed : allow]));
  if (!wordsWon) return;
  // Words never approve, whatever they say.
  expect(await s.tool(job, "agents_update", input)).toMatchObject({ ok: false, error: expect.stringMatching(/needs the owner's approval/) });
  await expect(call(router.questions.answer, { questionId: approval.id, answer: allow }, { context: s.context })).rejects.toMatchObject({ code: "CONFLICT" });
});

test("a person reads an agent's inbox: its consults, read-only, with the Job answering each; an agent that isn't there is not found", async () => {
  const s = await setup();
  const asking = await s.jobOf(s.asker);
  const q = await s.consult(asking.runId, s.expert.id);
  const consultedJob = await s.consulted(q.id);
  await s.ask((await s.jobOf(s.asker)).runId);
  const list = (agentId?: string) => call(router.questions.list, { status: "all", ...(agentId ? { agentId } : {}) }, { context: s.context });
  expect(await list(s.expert.id)).toEqual([expect.objectContaining({ id: q.id, kind: "consult", status: "pending", consultRunId: consultedJob, agent: expect.objectContaining({ id: s.asker.id }) })]);
  expect(await list(s.other.id)).toEqual([]);
  // A person's own inbox still holds no consult.
  expect((await list()).map((i) => i.kind)).toEqual(["question"]);
  await s.emit(consultedJob, { type: "result", text: "Plan B." });
  await vi.waitFor(async () => expect(await list(s.expert.id)).toEqual([expect.objectContaining({ id: q.id, status: "answered", answeredBy: expect.objectContaining({ type: "agent", runId: consultedJob }) })]));
  await expect(list("agent_nothing")).rejects.toMatchObject({ code: "NOT_FOUND" });
});
