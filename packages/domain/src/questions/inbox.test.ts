import { call } from "@orpc/server";
import type { Answer, QuestionPayload, ServerToRunner } from "@dispand/runner-protocol";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { agents, audit, events, questions, stepRuns } from "../db/schema.ts";
import { CliHarnessAdapter } from "../engine/cli-harness.ts";
import { answerText, attributed, Engine } from "../engine/engine.ts";
import type { AgentAnswerer, HarnessAdapter } from "../engine/harness.ts";
import { Scheduler } from "../engine/scheduler.ts";
import type { Bundle, TableScope } from "../platform/bundles.ts";
import { callPlatformTool, toolsOf, type JobIdentity } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { INTERACTION } from "../triggers/model.ts";

class FakeAdapter implements HarnessAdapter {
  answers: { sessionId: string; answer: Answer; by?: AgentAnswerer }[] = [];
  sends: { sessionId: string; text: string }[] = [];
  async start() {
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

/**
 * Clients and Notes (primitive). A person's write to one starts a Job of the agent watching it,
 * which asks. The Answerer (`inbox` on Clients) works in Jobs started by a button.
 */
async function setup() {
  const owner = await ownerContext();
  const adapter = new FakeAdapter();
  const engine = new Engine(owner.db, adapter);
  onTestFinished(() => engine.stop());
  const context = { ...owner, engine };
  const scheduler = new Scheduler(context.db, engine);
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
  /** A Job of `a`, started by a person's write to `t`. */
  const jobOn = async (a: { id: string }, t: { id: string; field: { id: string } }) => {
    await call(router.triggers.create, { agentId: a.id, name: "On row", instructions: "Look.", config: { kind: "primitive", tableId: t.id, operations: ["created"] } }, { context });
    await call(router.rows.create, { tableId: t.id, values: { [t.field.id]: "x" } }, { context });
    const [runId] = await scheduler.tick();
    return runId!;
  };
  /** A Job of `a`, started by a button. */
  const jobOf = async (a: { id: string }): Promise<JobIdentity> => {
    const trigger = await call(router.triggers.create, { agentId: a.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    return { runId, ownerId: context.ownerId, agentId: a.id };
  };
  const stepOf = async (runId: string) => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)))[0]!;
  let seq = 0;
  /** The Job's session asks; returns the item. */
  const ask = async (runId: string, payload: QuestionPayload = choice) => {
    const step = await stepOf(runId);
    await engine.onHarnessEvent(step.sessionId!, { type: "question", questionId: `rq_${++seq}`, payload }, { runnerId, seq });
    const [q] = await context.db.select().from(questions).where(and(eq(questions.runId, runId), eq(questions.runnerQuestionId, `rq_${seq}`)));
    return q!;
  };
  const questionOf = async (id: string) => (await context.db.select().from(questions).where(eq(questions.id, id)))[0]!;
  const tool = (job: JobIdentity, name: string, input: unknown = {}) => callPlatformTool(context, job, name, input);
  const answerer = await agent("Answerer", ["inbox"], [clients.id]);
  const clerk = await agent("Clerk", ["data"], [clients.id]);
  return { context, adapter, engine, clients, notes, agent, setRights, jobOn, jobOf, stepOf, ask, questionOf, tool, answerer, clerk };
}

/** Everything a refusal says, which must hold nothing of the item. */
function holdsNothing(result: unknown) {
  const words = JSON.stringify(result);
  for (const secret of ["merger", "Yes, sign it", "Merger"]) expect(words).not.toContain(secret);
}

test("an inbox Job lists, reads and answers another agent's Question on its tables; the asking Job goes on, told who answered", async () => {
  const s = await setup();
  const asking = await s.jobOn(s.clerk, s.clients);
  const q = await s.ask(asking);
  const job = await s.jobOf(s.answerer);
  expect((await toolsOf(s.context.db, job)).map((t) => t.name)).toEqual(["questions_list", "questions_get", "questions_answer", "memory_read"]);
  const item = { id: q.id, askedBy: { agent: { id: s.clerk.id, name: "Clerk" }, jobId: asking }, questions: (choice as { questions: unknown[] }).questions };
  expect(await s.tool(job, "questions_list")).toMatchObject({ ok: true, output: [item] });
  expect(await s.tool(job, "questions_get", { questionId: q.id })).toMatchObject({ ok: true, output: item });

  expect(await s.tool(job, "questions_answer", { questionId: q.id, answer: yes })).toEqual({ ok: true, output: { answered: q.id } });
  const answered = await s.questionOf(q.id);
  expect(answered).toMatchObject({ status: "answered", answer: yes, answeredBy: { type: "agent", agentId: s.answerer.id, runId: job.runId, name: "Answerer" } });
  // The asking session gets the answer once, with who gave it.
  const session = (await s.stepOf(asking)).sessionId!;
  await vi.waitFor(() => expect(s.adapter.answers).toEqual([{ sessionId: session, answer: yes, by: answered.answeredBy }]));
  expect(s.adapter.sends).toEqual([]);
  // The event is the answering Job's write.
  const [event] = await s.context.db.select().from(events).where(and(eq(events.tableId, INTERACTION), eq(events.rowId, q.id), eq(events.operation, "answered")));
  expect(event!.actor).toEqual({ type: "job", runId: job.runId });
  // Audited on the asking Job, as the answering Job's: its kind and decision, never its words.
  const rows = await s.context.db.select().from(audit).where(eq(audit.resourceId, q.id));
  // With the answering Job's own call that read it (`questions_get`).
  expect(rows.map((r) => r.action).sort()).toEqual(["platform.call", "question.answered", "question.asked"]);
  expect(rows.find((r) => r.action === "platform.call")).toMatchObject({ actor: { type: "job", runId: job.runId }, jobId: job.runId, details: { tool: "questions_get" } });
  expect(rows.find((r) => r.action === "question.answered")).toMatchObject({
    actor: { type: "job", runId: job.runId },
    actorAgentId: s.answerer.id,
    jobId: asking,
    resourceType: "question",
    details: { questionKind: "question", decision: "choice", answeredBy: "agent" },
  });
  holdsNothing(rows);
});

test("a Question of a Job with configure, of the reader's own agent, or on tables beyond the reader's, and an Approval, are refused alike and wait for a person", async () => {
  const s = await setup();
  const builder = await s.agent("Builder", ["data", "configure"], [s.clients.id]);
  const wide = await s.agent("Wide", ["data"], [s.clients.id, s.notes.id]);
  const job = await s.jobOf(s.answerer);
  const own = (await s.jobOf(s.answerer)).runId;
  const items = [
    await s.ask(await s.jobOn(builder, s.clients)),
    await s.ask(own),
    await s.ask(await s.jobOn(wide, s.clients)),
    await s.ask(await s.jobOn(s.clerk, s.clients), { kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false }),
    // A confirmation of a Job's values is a person's too.
    await s.ask(await s.jobOn(await s.agent("Filer", ["data"], [s.clients.id]), s.clients), { kind: "confirm-outputs", values: { total: 1 } } as never),
  ];
  expect(await s.tool(job, "questions_list")).toEqual({ ok: true, output: [] });
  for (const q of [...items, { id: "q_nothing" }]) {
    expect(await s.tool(job, "questions_get", { questionId: q.id })).toEqual(NOT_FOUND);
    expect(await s.tool(job, "questions_answer", { questionId: q.id, answer: yes })).toEqual(NOT_FOUND);
  }
  for (const q of items) expect((await s.questionOf(q.id)).status).toBe("pending");
});

test("an answered or an expired Question is gone from list, and get and answer say it no longer waits, with nothing of it", async () => {
  const s = await setup();
  const job = await s.jobOf(s.answerer);
  const answered = await s.ask(await s.jobOn(s.clerk, s.clients));
  await s.engine.answer(answered.id, yes, { type: "user", userId: s.context.ownerId });
  const stopped = await s.jobOn(await s.agent("Other", ["data"], [s.clients.id]), s.clients);
  const expired = await s.ask(stopped);
  await s.engine.stopRun(stopped);
  expect((await s.questionOf(expired.id)).status).toBe("expired");
  expect(await s.tool(job, "questions_list")).toEqual({ ok: true, output: [] });
  for (const q of [answered, expired]) {
    for (const result of [await s.tool(job, "questions_get", { questionId: q.id }), await s.tool(job, "questions_answer", { questionId: q.id, answer: yes })]) {
      expect(result).toEqual(CLOSED);
      holdsNothing(result);
    }
  }
  expect((await s.questionOf(answered.id)).answeredBy).toEqual({ type: "user", userId: s.context.ownerId });
});

test("a table granted after the Job was created reaches nothing for it; a table or inbox taken away ends its reach at once", async () => {
  const s = await setup();
  await s.setRights(s.answerer, ["inbox"], [s.notes.id]);
  const job = await s.jobOf(s.answerer);
  const q = await s.ask(await s.jobOn(s.clerk, s.clients));
  await s.setRights(s.answerer, ["inbox"], [s.clients.id, s.notes.id]);
  expect(await s.tool(job, "questions_list")).toEqual({ ok: true, output: [] });
  expect(await s.tool(job, "questions_get", { questionId: q.id })).toEqual(NOT_FOUND);
  expect(await s.tool(job, "questions_answer", { questionId: q.id, answer: yes })).toEqual(NOT_FOUND);
  // A Job created now has it, until the table is taken away.
  const later = await s.jobOf(s.answerer);
  expect(await s.tool(later, "questions_get", { questionId: q.id })).toMatchObject({ ok: true });
  await s.setRights(s.answerer, ["inbox"], [s.notes.id]);
  expect(await s.tool(later, "questions_list")).toEqual({ ok: true, output: [] });
  expect(await s.tool(later, "questions_get", { questionId: q.id })).toEqual(NOT_FOUND);
  expect(await s.tool(later, "questions_answer", { questionId: q.id, answer: yes })).toEqual(NOT_FOUND);
  await s.setRights(s.answerer, ["data"], [s.clients.id]);
  expect(await s.tool(later, "questions_get", { questionId: q.id })).toEqual({ ok: false, error: "This agent may not use questions_get" });
  expect((await s.questionOf(q.id)).status).toBe("pending");
});

test("a person's and an agent's answers at once: one wins, the other is told the item no longer waits, and the asking Job goes on once", async () => {
  const s = await setup();
  const asking = await s.jobOn(s.clerk, s.clients);
  const q = await s.ask(asking);
  const job = await s.jobOf(s.answerer);
  const no: Answer = { kind: "choice", answers: { [SECRET]: "No" } };
  const [person, agent] = await Promise.allSettled([s.engine.answer(q.id, no, { type: "user", userId: s.context.ownerId }), s.tool(job, "questions_answer", { questionId: q.id, answer: yes })]);
  const agentWon = agent.status === "fulfilled" && agent.value.ok;
  if (agentWon) expect(person).toMatchObject({ status: "rejected", reason: { code: "NOT_PENDING" } });
  else expect([person.status, agent]).toEqual(["fulfilled", { status: "fulfilled", value: CLOSED }]);
  const row = await s.questionOf(q.id);
  expect(row.answer).toEqual(agentWon ? yes : no);
  expect(row.answeredBy?.type).toBe(agentWon ? "agent" : "user");
  const session = (await s.stepOf(asking)).sessionId!;
  await vi.waitFor(() => expect(s.adapter.answers.filter((a) => a.sessionId === session)).toEqual([{ sessionId: session, answer: row.answer }]));
  const answeredEvents = await s.context.db.select().from(events).where(and(eq(events.tableId, INTERACTION), eq(events.rowId, q.id), eq(events.operation, "answered")));
  expect(answeredEvents).toHaveLength(1);
});

test("a person grants inbox; an agent gets it only through a proposal a person approved", async () => {
  const s = await setup();
  const builder = await s.agent("Builder", ["configure"], "all");
  const job = await s.jobOf(builder);
  const input = { id: s.clerk.id, name: "Clerk", harnessId: (await s.context.db.select().from(agents).where(eq(agents.id, s.clerk.id)))[0]!.harnessId!, systemPrompt: "", skillPackageIds: [], toolIds: [], bundles: ["data", "inbox"], dataTables: [s.clients.id] };
  expect(await s.tool(job, "agents_update", input)).toMatchObject({ ok: false, error: expect.stringMatching(/needs the owner's approval/) });
  expect((await s.context.db.select().from(agents).where(eq(agents.id, s.clerk.id)))[0]!.bundles).toEqual(["data"]);
  const made = await s.tool(job, "propose", { items: [{ tool: "agents_update", input }] });
  const proposal = (made as { output: { proposalId: string } }).output.proposalId;
  const approval = await s.ask(job.runId, { kind: "permission", toolName: "request_approval", input: { message: "Let Clerk answer questions", proposal } as never, canAlwaysAllow: false });
  await call(router.questions.answer, { questionId: approval.id, answer: { kind: "permission", decision: "allow" } }, { context: s.context });
  expect(await s.tool(job, "agents_update", input)).toMatchObject({ ok: true });
  expect((await s.context.db.select().from(agents).where(eq(agents.id, s.clerk.id)))[0]!.bundles).toEqual(["data", "inbox"]);
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
  const session = (await s.stepOf(await s.jobOn(s.clerk, s.clients))).sessionId!;
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_runnerId: string, msg: ServerToRunner) => sent.push(msg) > 0 };
  const cli = new CliHarnessAdapter(s.context.db, hub as never);
  const by = { type: "agent" as const, agentId: s.answerer.id, runId: "run_1", name: "Answerer" };
  await cli.answer(session, "rq_1", yes, by);
  await cli.answer(session, "rq_2", yes);
  expect(sent).toEqual([
    { type: "session.answer", sessionId: session, questionId: "rq_1", answer: attributed(yes, "Answerer") },
    { type: "session.answer", sessionId: session, questionId: "rq_2", answer: yes },
  ]);
});

test("an answer too long to carry who gave it is refused, and the item still waits", async () => {
  const s = await setup();
  const q = await s.ask(await s.jobOn(s.clerk, s.clients));
  const job = await s.jobOf(s.answerer);
  expect(await s.tool(job, "questions_answer", { questionId: q.id, answer: { kind: "choice", answers: { [SECRET]: "x".repeat(3990) } } })).toEqual({ ok: false, error: "An answer is too long" });
  expect((await s.questionOf(q.id)).status).toBe("pending");
});

test("a run shows a pending proposal Approval with its items, in its snapshot and its stream; once answered, without them", async () => {
  const s = await setup();
  const builder = await s.agent("Builder", ["configure"], "all");
  const job = await s.jobOf(builder);
  const input = { id: s.clerk.id, name: "Clerk", harnessId: (await s.context.db.select().from(agents).where(eq(agents.id, s.clerk.id)))[0]!.harnessId!, systemPrompt: "", skillPackageIds: [], toolIds: [], bundles: ["data", "inbox"], dataTables: [s.clients.id] };
  const made = await s.tool(job, "propose", { items: [{ tool: "agents_update", input }] });
  const proposal = (made as { output: { proposalId: string } }).output.proposalId;
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const stream = await call(router.runs.stream, { runId: job.runId }, { context: s.context, signal: abort.signal });
  expect((await stream.next()).value).toMatchObject({ type: "snapshot" });
  const approval = await s.ask(job.runId, { kind: "permission", toolName: "request_approval", input: { message: "Let Clerk answer questions", proposal } as never, canAlwaysAllow: false });
  const shown = { id: proposal, status: "asked", items: [{ tool: "agents_update", input, used: false }], names: { [s.clerk.id]: { kind: "agent", name: "Clerk" } } };
  let event = (await stream.next()).value as { type: string; question?: unknown };
  while (event.type !== "question") event = (await stream.next()).value as typeof event;
  expect(event.question).toMatchObject({ id: approval.id, proposalId: proposal, proposal: shown });
  expect((await call(router.runs.get, { runId: job.runId }, { context: s.context })).questions).toMatchObject([{ id: approval.id, proposal: shown }]);
  await call(router.questions.answer, { questionId: approval.id, answer: { kind: "permission", decision: "deny", message: "Only Clients, not Notes" } }, { context: s.context });
  expect((await call(router.runs.get, { runId: job.runId }, { context: s.context })).questions).toMatchObject([{ id: approval.id, status: "answered", proposal: null }]);
});

test("a proposal declined with words in the chat: the agent is told them, the items stay refused, and a click after it is told it is answered", async () => {
  const s = await setup();
  const builder = await s.agent("Builder", ["configure"], "all");
  const job = await s.jobOf(builder);
  const input = { id: s.clerk.id, name: "Clerk", harnessId: (await s.context.db.select().from(agents).where(eq(agents.id, s.clerk.id)))[0]!.harnessId!, systemPrompt: "", skillPackageIds: [], toolIds: [], bundles: ["data", "inbox"], dataTables: [s.clients.id] };
  const made = await s.tool(job, "propose", { items: [{ tool: "agents_update", input }] });
  const proposal = (made as { output: { proposalId: string } }).output.proposalId;
  const approval = await s.ask(job.runId, { kind: "permission", toolName: "request_approval", input: { message: "Let Clerk answer questions", proposal } as never, canAlwaysAllow: false });
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
