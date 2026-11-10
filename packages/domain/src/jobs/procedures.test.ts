import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { account, user } from "../db/schema.ts";
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

  const ids = async (input: { agentId?: string; workflowId?: string }) => (await call(router.runs.list, input, { context })).map((r) => r.id);
  expect(await ids({ agentId: agent.id })).toEqual([job.runId]);
  expect(await ids({ workflowId: workflow.id })).toEqual([run.runId]);
  expect((await ids({})).sort()).toEqual([job.runId, run.runId].sort());
  await expect(ids({ agentId: "agent_nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("an agent with a Job still going cannot be deleted", async () => {
  const { context, agent, trigger } = await setup();
  const button = await trigger({ kind: "manual", placement: "button" });
  await call(router.jobs.start, { triggerId: button.id }, { context });
  await expect(call(router.agents.delete, { id: agent.id }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
    message: "A Job of this agent is still going",
  });
});
