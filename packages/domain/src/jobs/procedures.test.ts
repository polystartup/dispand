import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { account, messages, questions, runs as runsTable, stepRuns, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { TriggerConfig } from "../triggers/model.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(
    await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }),
  );
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const trigger = (config: TriggerConfig) => call(router.triggers.create, { agentId: agent.id, name: "Mail", instructions: "Sort the mail.", config }, { context });
  return { context, agent, trigger };
}

test("starts a Job from a button trigger", async () => {
  const { context, agent, trigger } = await setup();
  const button = await trigger({ kind: "manual", placement: "button" });
  const started = await call(router.jobs.start, { triggerId: button.id }, { context });
  expect(started).toEqual({ runId: expect.stringMatching(/^run_/) });
  const { run } = await call(router.runs.get, { runId: started.runId }, { context });
  expect(run).toMatchObject({ source: "agent", workflowId: null, agentId: agent.id, triggerId: button.id, status: "running" });
  // A Job's definition is its own (a workflow run's is its workflow version's).
  expect(await call(router.jobs.def, { runId: started.runId }, { context })).toMatchObject({ steps: [{ id: "job", name: "Clerk", prompt: "Sort the mail." }] });
  await expect(call(router.jobs.def, { runId: "run_nobody" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("starts a chat Job and gives its session", async () => {
  const { context, trigger } = await setup();
  const chat = await trigger({ kind: "manual", placement: "chat" });
  const started = await call(router.jobs.start, { triggerId: chat.id }, { context });
  expect(started).toEqual({ runId: expect.stringMatching(/^run_/), chatSessionId: expect.stringMatching(/^ses_/) });
});

test("refuses a disabled trigger, a schedule trigger and another owner's", async () => {
  const { context, trigger } = await setup();
  const button = await trigger({ kind: "manual", placement: "button" });
  const schedule = await trigger({ kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Paris" });
  await expect(call(router.jobs.start, { triggerId: schedule.id }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await call(router.triggers.update, { id: button.id, enabled: false }, { context });
  await expect(call(router.jobs.start, { triggerId: button.id }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await call(router.triggers.update, { id: button.id, enabled: true }, { context });

  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  // Eve signs in on the same app.
  const ctx = await context.auth.$context;
  await context.db.insert(account).values({
    id: "acct_other",
    accountId: "user_other",
    providerId: "credential",
    userId: "user_other",
    password: await ctx.password.hash("eve's password"),
  });
  const res = await context.auth.api.signInEmail({ body: { email: "eve@example.com", password: "eve's password" }, returnHeaders: true });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const other = { ...context, headers: new Headers({ cookie }) };
  await expect(call(router.jobs.start, { triggerId: button.id }, { context: other })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await call(router.runs.list, {}, { context })).toEqual([]);
});

test("runs.list filters by agentId and by workflowId", async () => {
  const { context, agent, trigger } = await setup();
  const button = await trigger({ kind: "manual", placement: "button" });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(
    router.workflows.update,
    {
      id: workflow.id,
      name: "Ship",
      def: {
        trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
        steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId: agent.id, prompt: "Write a note." }],
        edges: [{ from: "n_go", to: "n_note" }],
      },
    },
    { context },
  );
  const job = await call(router.jobs.start, { triggerId: button.id }, { context });
  const run = await call(router.runs.start, { workflowId: workflow.id }, { context });

  const ids = async (input: { agentId?: string; workflowId?: string; triggerId?: string }) => (await call(router.runs.list, input, { context })).map((r) => r.id);
  expect(await ids({ agentId: agent.id })).toEqual([job.runId]);
  // By trigger: another trigger of the same agent has its own Jobs.
  const other = await trigger({ kind: "manual", placement: "button" });
  const second = await call(router.jobs.start, { triggerId: other.id }, { context });
  expect(await ids({ triggerId: button.id })).toEqual([job.runId]);
  expect(await ids({ triggerId: other.id })).toEqual([second.runId]);
  await expect(ids({ triggerId: "trigger_nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await call(router.triggers.delete, { id: other.id }, { context });
  await context.db.delete(runsTable).where(eq(runsTable.id, second.runId));
  expect(await ids({ workflowId: workflow.id })).toEqual([run.runId]);
  expect((await ids({})).sort()).toEqual([job.runId, run.runId].sort());
  await expect(ids({ agentId: "agent_nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("deleting an agent stops its Job still going, as a person's stop, and keeps it", async () => {
  const { context, agent, trigger } = await setup();
  const chat = await trigger({ kind: "manual", placement: "chat" });
  const { runId } = await call(router.jobs.start, { triggerId: chat.id }, { context });
  await call(router.agents.delete, { id: agent.id }, { context });
  const { run } = await call(router.runs.get, { runId }, { context });
  expect(run).toMatchObject({ id: runId, status: "failed", error: "Stopped", agentId: null, deletedAgentName: "Clerk (Deleted)" });
  // Stopped once: it never runs again.
  await expect(call(router.runs.stop, { runId }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
});

test("deleting an agent keeps its Jobs, their transcripts and Questions, named after it as deleted", async () => {
  const { context, agent, trigger } = await setup();
  const button = await trigger({ kind: "manual", placement: "button" });
  const { runId } = await call(router.jobs.start, { triggerId: button.id }, { context });
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  await context.db.insert(messages).values({ id: "msg_1", ownerId: context.ownerId, runId, stepRunId: step!.id, role: "assistant", text: "Drafted the order." });
  await context.db.insert(questions).values({
    id: "q_1",
    ownerId: context.ownerId,
    runId,
    stepRunId: step!.id,
    placement: "notifications",
    kind: "question",
    payload: { kind: "choice", questions: [{ question: "Which supplier?", header: "Supplier", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    status: "answered",
    answer: { kind: "choice", answers: { "Which supplier?": ["A"] } },
    answeredAt: new Date(),
  });
  await call(router.runs.stop, { runId }, { context });
  // Renamed since the Job: it keeps the name the agent had when deleted.
  await call(router.agents.update, { id: agent.id, name: "Order drafter", harnessId: agent.harnessId, systemPrompt: "" }, { context });
  await call(router.agents.delete, { id: agent.id }, { context });

  expect(await call(router.agents.list, undefined, { context })).toEqual([]);
  expect(await call(router.jobs.list, {}, { context })).toMatchObject([{ id: runId, agentId: null, agentName: "Order drafter (Deleted)", triggerId: null }]);
  const job = await call(router.jobs.get, { id: runId }, { context });
  expect(job).toMatchObject({ agentId: null, agentName: "Order drafter (Deleted)", totalMessages: 1, messages: [{ text: "Drafted the order." }], questions: [{ id: "q_1", status: "answered" }] });
  expect((await call(router.runs.list, {}, { context })).map((r) => [r.id, r.deletedAgentName])).toEqual([[runId, "Order drafter (Deleted)"]]);
  // The Inbox item it raised names it too.
  expect(await call(router.questions.list, { status: "all" }, { context })).toMatchObject([{ id: "q_1", agent: { id: null, name: "Order drafter (Deleted)" } }]);
});

test("runs.stop ends a Job", async () => {
  const { context, trigger } = await setup();
  const chat = await trigger({ kind: "manual", placement: "chat" });
  const { runId } = await call(router.jobs.start, { triggerId: chat.id }, { context });
  await call(router.runs.stop, { runId }, { context });
  expect((await call(router.runs.get, { runId }, { context })).run).toMatchObject({ status: "failed", error: "Stopped" });
  // Stopped once: a second stop says the run is over; someone else's run isn't found.
  await expect(call(router.runs.stop, { runId }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.runs.stop, { runId: "run_nobody" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("runs.list keeps the chat Jobs of a trigger, each titled by its first message", async () => {
  const { context, trigger } = await setup();
  const chat = await trigger({ kind: "manual", placement: "chat" });
  const button = await trigger({ kind: "manual", placement: "button" });
  const first = (await call(router.jobs.start, { triggerId: chat.id }, { context })).runId;
  const second = (await call(router.jobs.start, { triggerId: chat.id }, { context })).runId;
  const third = (await call(router.jobs.start, { triggerId: chat.id }, { context })).runId;
  const press = (await call(router.jobs.start, { triggerId: button.id }, { context })).runId;
  await call(router.runs.sendChat, { runId: first, text: "Which agents touch Matters?" }, { context });
  await call(router.runs.sendChat, { runId: first, text: "And when?" }, { context });
  // Cut at 80 characters, its whitespace folded.
  const long = `Set up\n\n${"my practice ".repeat(20)}`;
  await call(router.runs.sendChat, { runId: second, text: long }, { context });

  const list = await call(router.runs.list, { kind: "chat" }, { context });
  // Newest first; the button's Job is no conversation; a conversation with no message has no title yet.
  expect(list.map((r) => [r.id, r.title])).toEqual([
    [third, null],
    [second, long.slice(0, 80).replace(/\s+/g, " ").trim()],
    [first, "Which agents touch Matters?"],
  ]);
  expect(list[1]!.title!.length).toBeLessThanOrEqual(80);
  expect((await call(router.runs.list, { triggerId: chat.id }, { context })).map((r) => r.id)).toEqual([third, second, first]);
  expect((await call(router.runs.list, {}, { context })).map((r) => r.id)).toContain(press);
  await expect(call(router.runs.list, { kind: "button" as never }, { context })).rejects.toBeDefined();
});
