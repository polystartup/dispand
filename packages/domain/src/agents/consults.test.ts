import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agentConsults, agents, harnesses, proposals, questions, runs, stepRuns, user } from "../db/schema.ts";
import { callPlatformTool, type JobIdentity } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { pairProblem } from "./consults.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const base = { harnessId: harness.id, systemPrompt: "", skillPackageIds: [], toolIds: [] };
  const make = (name: string, bundles: ("data" | "configure")[] = ["data"]) => call(router.agents.create, { ...base, name, bundles }, { context });
  return { context, runnerId, harness, base, make };
}

test("an agent's description and consult list are saved, given back, and left as they are when an update leaves them out", async () => {
  const { context, base, make } = await setup();
  const architect = await make("Architect");
  const owner = await call(router.agents.create, { ...base, name: "Product owner", bundles: ["data"], description: "Decides what we build.", consults: [{ agentId: architect.id, ask: true }] }, { context });
  expect(owner.description).toBe("Decides what we build.");
  expect((await call(router.agents.get, { id: owner.id }, { context })).consults).toEqual([{ agentId: architect.id, ask: true, inactive: null }]);
  expect((await call(router.agents.get, { id: architect.id }, { context })).description).toBe("");

  await call(router.agents.update, { ...base, id: owner.id, name: "Product owner" }, { context });
  const kept = await call(router.agents.get, { id: owner.id }, { context });
  expect(kept.description).toBe("Decides what we build.");
  expect(kept.consults).toEqual([{ agentId: architect.id, ask: true, inactive: null }]);
  // The flag changes, and a list given empty removes every entry.
  await call(router.agents.update, { ...base, id: owner.id, name: "Product owner", consults: [{ agentId: architect.id, ask: false }] }, { context });
  expect((await call(router.agents.get, { id: owner.id }, { context })).consults).toEqual([{ agentId: architect.id, ask: false, inactive: null }]);
  await call(router.agents.update, { ...base, id: owner.id, name: "Product owner", description: "", consults: [] }, { context });
  expect(await call(router.agents.get, { id: owner.id }, { context })).toMatchObject({ description: "", consults: [] });
});

test("an entry naming the agent itself, another owner's agent, or an agent across the configure line is refused with the reason", async () => {
  const { context, harness, base, make } = await setup();
  const clerk = await make("Clerk");
  const builder = await make("Builder", ["data", "configure"]);
  const update = (consults: { agentId: string; ask: boolean }[]) => call(router.agents.update, { ...base, id: clerk.id, name: "Clerk", bundles: ["data"], consults }, { context });
  await expect(update([{ agentId: clerk.id, ask: false }])).rejects.toMatchObject({ code: "BAD_REQUEST", message: "An agent can't consult itself" });
  await expect(update([{ agentId: builder.id, ask: false }])).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Builder changes the workspace and Clerk doesn't: an agent that changes the workspace and one that doesn't never consult each other",
  });
  await expect(call(router.agents.create, { ...base, name: "Admin", bundles: ["configure"], consults: [{ agentId: clerk.id, ask: false }] }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("Admin changes the workspace and Clerk doesn't"),
  });
  // Refused in the agent's own transaction: nothing of the refused create is left.
  expect((await context.db.select({ name: agents.name }).from(agents).where(eq(agents.ownerId, context.ownerId))).map((a) => a.name).sort()).toEqual(["Builder", "Clerk"]);
  await expect(update([{ agentId: "agent_nobody", ask: false }])).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Agent not found" });
  // Another owner's agent is not one to consult.
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(harnesses).values({ id: "harness_other", ownerId: "user_other", name: "Eve's", runnerId: harness.runnerId, kind: "claude-code", permissionMode: "default" });
  await context.db.insert(agents).values({ id: "agent_eve", ownerId: "user_other", name: "Eve's clerk", harnessId: "harness_other", systemPrompt: "", bundles: ["data"] });
  await expect(update([{ agentId: "agent_eve", ask: false }])).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Agent not found" });
  expect(await context.db.select().from(agentConsults)).toEqual([]);
  // Both with configure, or both without: allowed.
  const admin = await call(router.agents.create, { ...base, name: "Admin", bundles: ["configure"], consults: [{ agentId: builder.id, ask: false }] }, { context });
  expect(await pairProblem(context.db, context.ownerId, admin.id, builder.id)).toBeNull();
});

test("an entry a later bundle change puts across the configure line is kept, shown inactive, and saving the agent keeps it", async () => {
  const { context, base, make } = await setup();
  const architect = await make("Architect");
  const owner = await call(router.agents.create, { ...base, name: "Owner", bundles: ["data"], consults: [{ agentId: architect.id, ask: false }] }, { context });
  await call(router.agents.update, { ...base, id: architect.id, name: "Architect", bundles: ["data", "configure"] }, { context });
  const entry = { agentId: architect.id, ask: false, inactive: "Architect changes the workspace and Owner doesn't: an agent that changes the workspace and one that doesn't never consult each other" };
  expect((await call(router.agents.get, { id: owner.id }, { context })).consults).toEqual([entry]);
  await call(router.agents.update, { ...base, id: owner.id, name: "Owner", systemPrompt: "Changed.", consults: [{ agentId: architect.id, ask: false }] }, { context });
  expect((await call(router.agents.get, { id: owner.id }, { context })).consults).toEqual([entry]);
});

test("an entry goes away with either of its agents", async () => {
  const { context, base, make } = await setup();
  const a = await make("A");
  const b = await make("B");
  const c = await make("C");
  await call(router.agents.update, { ...base, id: a.id, name: "A", consults: [{ agentId: b.id, ask: false }, { agentId: c.id, ask: false }] }, { context });
  await call(router.agents.update, { ...base, id: b.id, name: "B", consults: [{ agentId: a.id, ask: false }] }, { context });
  await call(router.agents.delete, { id: c.id }, { context });
  expect(await context.db.select().from(agentConsults)).toEqual([
    { agentId: a.id, consultedId: b.id, ask: false },
    { agentId: b.id, consultedId: a.id, ask: false },
  ].sort((x, y) => x.agentId.localeCompare(y.agentId)));
  await call(router.agents.delete, { id: a.id }, { context });
  expect(await context.db.select().from(agentConsults)).toEqual([]);
});

test("a Job keeps the consult list as it was when it was created", async () => {
  const { context, base, make } = await setup();
  const architect = await make("Architect");
  const owner = await call(router.agents.create, { ...base, name: "Owner", consults: [{ agentId: architect.id, ask: true }] }, { context });
  const trigger = await call(router.triggers.create, { agentId: owner.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  await call(router.agents.update, { ...base, id: owner.id, name: "Owner", consults: [] }, { context });
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  expect(run!.snapshot!.consults).toEqual([{ agentId: architect.id, ask: true }]);
});

test("a Job names an agent to consult, or changes a description, only through an approved proposal, which names the agent", async () => {
  const { context, runnerId, base, make } = await setup();
  const architect = await make("Architect", ["configure"]);
  const builder = await make("Builder", ["configure"]);
  const trigger = await call(router.triggers.create, { agentId: builder.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const job: JobIdentity = { runId: (await call(router.jobs.start, { triggerId: trigger.id }, { context })).runId, ownerId: context.ownerId, agentId: builder.id };
  const input = { ...base, id: builder.id, name: "Builder", bundles: ["configure"], description: "Builds tables.", consults: [{ agentId: architect.id, ask: false }] };
  const refused = await callPlatformTool(context, job, "agents_update", input);
  expect((refused as { error: string }).error).toMatch(/needs the owner's approval/);
  expect(await context.db.select().from(agentConsults)).toEqual([]);

  const made = await callPlatformTool(context, job, "propose", { items: [{ tool: "agents_update", input }] });
  const proposalId = (made as { output: { proposalId: string } }).output.proposalId;
  // The owner reads the agent it may consult by name, in the Inbox.
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, job.runId));
  await context.engine.onHarnessEvent(step!.sessionId!, { type: "question", questionId: "rq_1", payload: { kind: "permission", toolName: "request_approval", input: { message: "May I?", proposal: proposalId } as never, canAlwaysAllow: false } }, { runnerId, seq: 1 });
  const [q] = await context.db.select().from(questions).where(eq(questions.runnerQuestionId, "rq_1"));
  const item = (await call(router.questions.list, { status: "pending" }, { context })).find((i) => i.id === q!.id)!;
  expect(item.proposal!.items[0]!.input).toMatchObject({ description: "Builds tables.", consults: [{ agentId: architect.id, ask: false }] });
  expect(item.proposal!.names[architect.id]).toEqual({ kind: "agent", name: "Architect" });

  await call(router.questions.answer, { questionId: q!.id, answer: { kind: "permission", decision: "allow" } }, { context });
  expect((await context.db.select().from(proposals).where(eq(proposals.id, proposalId)))[0]!.status).toBe("approved");
  expect(await callPlatformTool(context, job, "agents_update", input)).toMatchObject({ ok: true });
  expect(await call(router.agents.get, { id: builder.id }, { context })).toMatchObject({ description: "Builds tables.", consults: [{ agentId: architect.id, ask: false, inactive: null }] });
});
