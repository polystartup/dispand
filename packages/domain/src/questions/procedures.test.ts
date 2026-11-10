import { call } from "@orpc/server";
import { type Answer, type QuestionPayload } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { answerText, Engine } from "../engine/engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "../engine/harness.ts";
import { questions, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

class FakeAdapter implements HarnessAdapter {
  sessions: string[] = [];
  answers: [string, string, Answer][] = [];
  sent: [string, string][] = [];
  async start(_harness: Harness, start: StartParams) {
    this.sessions.push(start.sessionId);
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
  async stop() {
    return true;
  }
}

/** A run of a one-step workflow whose session asked `payload` (the question is the run's first). */
async function asked(payload: QuestionPayload, chat = false) {
  const base = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: base });
  const harness = await call(
    router.harnesses.create,
    { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" },
    { context: base },
  );
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context: base });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context: base });
  await call(
    router.workflows.update,
    {
      id: workflow.id,
      name: "Ship",
      def: {
        trigger: {
          type: "manual",
          field: chat
            ? { id: "n_go", key: "go", type: "chat", label: "Go", agentId: agent.id, prompt: "Ask." }
            : { id: "n_go", key: "go", type: "button", label: "Go" },
        },
        steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId: agent.id, prompt: "Write." }],
        edges: [{ from: "n_go", to: "n_note" }],
      },
    },
    { context: base },
  );
  const adapter = new FakeAdapter();
  const engine = new Engine(base.db, adapter);
  onTestFinished(() => engine.stop());
  const context = { ...base, engine };
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.sessions[0]!; // the chat's session when `chat`, else the step's
  await vi.waitFor(async () => {
    const [row] = await base.db.select({ at: stepRuns.startDeliveredAt }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    expect(row!.at).toBeInstanceOf(Date);
  });
  let seq = 0;
  const emit = (event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  await emit({ type: "question", questionId: "rq_1", payload });
  const [question] = await base.db.select().from(questions).where(eq(questions.runId, runId));
  return { context, adapter, question: question!, sessionId, runId, emit };
}

const choice: QuestionPayload = {
  kind: "choice",
  questions: [
    { question: "Which tone?", header: "Tone", options: [{ label: "Formal" }, { label: "Casual" }], multiSelect: false },
    { question: "Which extras?", header: "Extras", options: [{ label: "Intro" }, { label: "Outro" }], multiSelect: true },
  ],
};

test("list and count show pending questions with their workflow, run and step", async () => {
  const { context, question, runId } = await asked(choice);
  expect(await call(router.questions.count, undefined, { context })).toEqual({ count: 1 });
  const [item] = await call(router.questions.list, { status: "pending" }, { context });
  expect(item).toMatchObject({
    id: question.id,
    status: "pending",
    orphaned: false,
    payload: choice,
    workflow: { name: "Ship" },
    run: { id: runId },
    step: { name: "Note" },
  });
});

test("second answer is rejected", async () => {
  const { context, adapter, question } = await asked({ kind: "confirm-outputs", values: { a: "1" } });
  const answers: Answer[] = [
    { kind: "confirm-outputs", confirmed: true },
    { kind: "confirm-outputs", confirmed: false },
  ];
  const results = await Promise.allSettled(answers.map((answer) => call(router.questions.answer, { questionId: question.id, answer }, { context })));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: "CONFLICT" });
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(1));
  expect(await call(router.questions.count, undefined, { context })).toEqual({ count: 0 });
});

test("chat questions count, stream and list like the others, and are answerable", async () => {
  const { context, adapter, question } = await asked({ kind: "confirm-outputs", values: {} }, true);
  expect(question.placement).toBe("chat");
  expect(await call(router.questions.count, undefined, { context })).toEqual({ count: 1 });
  const [item] = await call(router.questions.list, { status: "pending" }, { context });
  expect(item).toMatchObject({ id: question.id, placement: "chat" });
  await call(router.questions.answer, { questionId: question.id, answer: { kind: "confirm-outputs", confirmed: true } }, { context });
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(1));
  expect(await call(router.questions.count, undefined, { context })).toEqual({ count: 0 });
});

test("the answer is delivered trimmed", async () => {
  const { context, adapter, question } = await asked(choice);
  await call(
    router.questions.answer,
    { questionId: question.id, answer: { kind: "choice", answers: { "Which tone?": "  Formal ", "Which extras?": [" Intro", "Outro  "] } } },
    { context },
  );
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(1));
  expect(adapter.answers[0]![2]).toEqual({ kind: "choice", answers: { "Which tone?": "Formal", "Which extras?": ["Intro", "Outro"] } });
});

test("choice answers: structure is checked, any text is Other, single versus multi", async () => {
  const { context, adapter, question } = await asked(choice);
  const answer = (answers: Record<string, string | string[]>) =>
    call(router.questions.answer, { questionId: question.id, answer: { kind: "choice", answers } }, { context });

  // A question the payload doesn't ask.
  await expect(answer({ "Which tone?": "Formal", "Which extras?": ["Intro"], "Who?": "me" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // Every question needs an answer.
  await expect(answer({ "Which tone?": "Formal" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(answer({ "Which tone?": "Formal", "Which extras?": [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(answer({ "Which tone?": "  ", "Which extras?": ["Intro"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // multiSelect false refuses two labels.
  await expect(answer({ "Which tone?": ["Formal", "Casual"], "Which extras?": ["Intro"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // The same label twice is not two choices.
  await expect(answer({ "Which tone?": "Formal", "Which extras?": ["Intro", "Intro"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(adapter.answers).toHaveLength(0);

  // Free text is "Other"; multi-select takes several.
  await answer({ "Which tone?": "Playful, like a pirate", "Which extras?": ["Intro", "Outro"] });
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(1));
  expect(adapter.answers[0]![2]).toEqual({
    kind: "choice",
    answers: { "Which tone?": "Playful, like a pirate", "Which extras?": ["Intro", "Outro"] },
  });
});

test("permission and confirm-outputs answers must fit the question", async () => {
  const noAlways = await asked({ kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false });
  const answerTo = (answer: Answer) => call(router.questions.answer, { questionId: noAlways.question.id, answer }, { context: noAlways.context });
  await expect(answerTo({ kind: "permission", decision: "allow-always" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(answerTo({ kind: "confirm-outputs", confirmed: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await answerTo({ kind: "permission", decision: "deny", message: "Not now" });
  await vi.waitFor(() => expect(noAlways.adapter.answers).toHaveLength(1));

  const always = await asked({ kind: "permission", toolName: "Bash", input: {}, canAlwaysAllow: true });
  await call(router.questions.answer, { questionId: always.question.id, answer: { kind: "permission", decision: "allow-always" } }, { context: always.context });

  const confirm = await asked({ kind: "confirm-outputs", values: { a: "1" } });
  await expect(
    call(router.questions.answer, { questionId: confirm.question.id, answer: { kind: "permission", decision: "allow" } }, { context: confirm.context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("an unknown question is NOT_FOUND, an orphaned one is still listed and answerable", async () => {
  const { context, question, sessionId, adapter } = await asked({ kind: "confirm-outputs", values: {} });
  await expect(
    call(router.questions.answer, { questionId: "q_nope", answer: { kind: "confirm-outputs", confirmed: true } }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  await context.db.update(questions).set({ orphaned: true }).where(eq(questions.id, question.id));
  const [item] = await call(router.questions.list, { status: "pending" }, { context });
  expect(item).toMatchObject({ id: question.id, orphaned: true });
  await call(router.questions.answer, { questionId: question.id, answer: { kind: "confirm-outputs", confirmed: true } }, { context });
  // An orphaned question's answer goes as a message to the resumed session.
  await vi.waitFor(() => expect(adapter.sent.map(([id]) => id)).toContain(sessionId));
});

test("stream pushes the pending count: now, then on every change", async () => {
  const { context, question, emit } = await asked({ kind: "confirm-outputs", values: {} });
  const ac = new AbortController();
  const stream = await call(router.questions.stream, undefined, { context, signal: ac.signal });
  const next = async () => (await stream.next()).value;
  expect(await next()).toEqual({ count: 1 });
  await call(router.questions.answer, { questionId: question.id, answer: { kind: "confirm-outputs", confirmed: true } }, { context });
  expect(await next()).toEqual({ count: 0 });
  await emit({ type: "question", questionId: "rq_2", payload: { kind: "confirm-outputs", values: {} } });
  expect(await next()).toEqual({ count: 1 });
  ac.abort();
});

test("an answer too long to deliver as a message is refused before it is recorded", async () => {
  const { context, question, adapter } = await asked({ kind: "confirm-outputs", values: {} });
  await context.db.update(questions).set({ orphaned: true }).where(eq(questions.id, question.id));
  const answer = { kind: "confirm-outputs" as const, confirmed: false, feedback: "x".repeat(200_000) };
  await expect(call(router.questions.answer, { questionId: question.id, answer }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // Still pending, nothing sent: the owner can answer again, shorter.
  const [row] = await context.db.select().from(questions).where(eq(questions.id, question.id));
  expect(row!.status).toBe("pending");
  expect(adapter.sent).toEqual([]);
  await call(router.questions.answer, { questionId: question.id, answer: { ...answer, feedback: "shorter" } }, { context });
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(1));
});

test("labels that differ only by spaces stay distinct and exact", async () => {
  const spaced: QuestionPayload = {
    kind: "choice",
    questions: [{ question: "Which files?", header: "Files", options: [{ label: "a.txt " }, { label: "a.txt" }], multiSelect: true }],
  };
  const { context, adapter, question } = await asked(spaced);
  await call(router.questions.answer, { questionId: question.id, answer: { kind: "choice", answers: { "Which files?": ["a.txt ", "a.txt"] } } }, { context });
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(1));
  expect(adapter.answers[0]![2]).toEqual({ kind: "choice", answers: { "Which files?": ["a.txt ", "a.txt"] } });
});

test("a Job's question is listed with its agent and is answerable", async () => {
  const { context, adapter } = await asked(choice);
  const [agent] = await call(router.agents.list, undefined, { context });
  const trigger = await call(
    router.triggers.create,
    { agentId: agent!.id, name: "Mail", instructions: "Sort.", config: { kind: "manual", placement: "button" } },
    { context },
  );
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const sessionId = adapter.sessions[1]!;
  const [runner] = await call(router.runners.list, undefined, { context });
  await context.engine.onHarnessEvent(sessionId, { type: "question", questionId: "rq_job", payload: { kind: "confirm-outputs", values: {} } }, { runnerId: runner!.id, seq: 1 });

  expect(await call(router.questions.count, undefined, { context })).toEqual({ count: 2 });
  const listed = await call(router.questions.list, { status: "pending" }, { context });
  expect(listed).toHaveLength(2);
  const mine = listed.find((q) => q.run.id === runId)!;
  expect(mine).toMatchObject({ workflow: null, agent: { id: agent!.id, name: "Writer" }, step: { name: "Writer" } });
  expect(listed.find((q) => q.run.id !== runId)).toMatchObject({ workflow: { name: "Ship" }, agent: null });
  await call(router.questions.answer, { questionId: mine.id, answer: { kind: "confirm-outputs", confirmed: true } }, { context });
  expect(adapter.answers).toEqual([[sessionId, "rq_job", { kind: "confirm-outputs", confirmed: true }]]);
});

// The Inbox: questions and approvals, with who answered.

const permission: QuestionPayload = { kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false };
const all = (context: Awaited<ReturnType<typeof asked>>["context"]) => call(router.questions.list, { status: "all" }, { context });

test("a permission is an approval; a choice and a confirmation are questions", async () => {
  const a = await asked(permission);
  expect((await call(router.questions.list, { status: "pending" }, { context: a.context }))[0]).toMatchObject({ kind: "approval" });
  const b = await asked(choice);
  await b.emit({ type: "question", questionId: "rq_2", payload: { kind: "confirm-outputs", values: {} } });
  expect((await call(router.questions.list, { status: "pending" }, { context: b.context })).map((q) => q.kind)).toEqual(["question", "question"]);
});

test("an answer records who gave it and when", async () => {
  const { context, question } = await asked(permission);
  await call(router.questions.answer, { questionId: question.id, answer: { kind: "permission", decision: "allow" } }, { context });
  const [row] = await context.db.select().from(questions).where(eq(questions.id, question.id));
  expect(row).toMatchObject({ status: "answered", answeredBy: { type: "user", userId: context.ownerId } });
  expect(row!.answeredAt).toBeInstanceOf(Date);
  const [item] = await all(context);
  expect(item).toMatchObject({ id: question.id, status: "answered", kind: "approval", answer: { kind: "permission", decision: "allow" }, answeredBy: { type: "user", userId: context.ownerId } });
  expect(item!.answeredAt).toBeInstanceOf(Date);
});

test("status all lists the open items first, then the done ones; pending lists only the open ones", async () => {
  const { context, question, emit } = await asked(choice);
  await emit({ type: "question", questionId: "rq_2", payload: { kind: "confirm-outputs", values: {} } });
  await emit({ type: "question", questionId: "rq_3", payload: permission });
  await call(router.questions.answer, { questionId: question.id, answer: { kind: "choice", answers: { "Which tone?": "Formal", "Which extras?": ["Intro"] } } }, { context });
  const listed = await all(context);
  expect(listed.map((q) => q.status)).toEqual(["pending", "pending", "answered"]);
  expect(listed[2]).toMatchObject({ id: question.id, workflow: { name: "Ship" }, step: { name: "Note" } });
  expect(await call(router.questions.list, { status: "pending" }, { context })).toHaveLength(2);
  // The count is of what waits.
  expect(await call(router.questions.count, undefined, { context })).toEqual({ count: 2 });
});

test("every open item is listed, and the 100 latest done ones", async () => {
  const { context, question } = await asked(choice);
  const [row] = await context.db.select().from(questions).where(eq(questions.id, question.id));
  const copies = Array.from({ length: 105 }, (_, i) => ({
    ...row!,
    id: `q_done_${String(i).padStart(3, "0")}`,
    runnerQuestionId: `rq_done_${i}`,
    status: "answered" as const,
    answeredAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
  }));
  const open = Array.from({ length: 120 }, (_, i) => ({ ...row!, id: `q_open_${i}`, runnerQuestionId: `rq_open_${i}` }));
  await context.db.insert(questions).values([...copies, ...open]);
  const listed = await all(context);
  expect(listed.filter((q) => q.status === "pending")).toHaveLength(121);
  const done = listed.filter((q) => q.status === "answered");
  expect(done).toHaveLength(100);
  // The latest answered first; the five oldest are left out.
  expect(done[0]!.id).toBe("q_done_104");
  expect(done.at(-1)!.id).toBe("q_done_005");
});

test("a Job's item names its trigger, and stays listed without one when the trigger is deleted", async () => {
  const { context, adapter } = await asked(choice);
  const [agent] = await call(router.agents.list, undefined, { context });
  const trigger = await call(router.triggers.create, { agentId: agent!.id, name: "Mail", instructions: "Sort.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [runner] = await call(router.runners.list, undefined, { context });
  await context.engine.onHarnessEvent(adapter.sessions[1]!, { type: "question", questionId: "rq_job", payload: permission }, { runnerId: runner!.id, seq: 1 });
  const mine = async () => (await all(context)).find((q) => q.run.id === runId)!;
  expect(await mine()).toMatchObject({ kind: "approval", agent: { name: "Writer" }, trigger: { id: trigger.id, name: "Mail" }, workflow: null });
  expect((await all(context)).find((q) => q.run.id !== runId)).toMatchObject({ trigger: null });
  await call(router.triggers.delete, { id: trigger.id }, { context });
  expect(await mine()).toMatchObject({ agent: { name: "Writer" }, trigger: null });
});

test("an approval asked in words is told back in words to a session that was restarted", () => {
  const payload: QuestionPayload = { kind: "permission", toolName: "request_approval", input: { message: "Send this draft?" }, canAlwaysAllow: false };
  expect(answerText({ payload, answer: { kind: "permission", decision: "allow" } })).toBe("The owner approved your request (“Send this draft?”).");
  expect(answerText({ payload, answer: { kind: "permission", decision: "deny", message: "Not yet." } })).toBe("The owner denied your request (“Send this draft?”): Not yet.");
  // Cut words stay storable, or the request could never be answered.
  const long: QuestionPayload = { ...payload, input: { message: "a".repeat(499) + "😀 and more" } };
  const told = answerText({ payload: long, answer: { kind: "permission", decision: "allow" } });
  expect(told.isWellFormed()).toBe(true);
  expect(told).toContain("a".repeat(499));
  // A tool permission keeps its wording.
  expect(answerText({ payload: permission, answer: { kind: "permission", decision: "allow" } })).toBe("The owner allowed Bash.");
});
