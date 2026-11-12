import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, proposals, runs, triggers } from "../db/schema.ts";
import { ASSISTANT_PROMPT } from "../engine/job-def.ts";
import { callPlatformTool } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { ensureAssistant, ensureAssistants } from "./builtin.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  return { context, harness };
}

/** The Assistant made through the owner's procedure, with what `agents.update` needs to keep it as it is. */
async function withAssistant() {
  const s = await setup();
  const ids = await call(router.agents.ensureAssistant, { harnessId: s.harness.id }, { context: s.context });
  const agent = await call(router.agents.get, { id: ids.agentId }, { context: s.context });
  const fields = { id: agent.id, name: agent.name, harnessId: agent.harnessId, systemPrompt: agent.systemPrompt, skillPackageIds: agent.skills.map((s) => s.packageId), toolIds: [] };
  return { ...s, ...ids, agent, fields };
}

test("an owner has no Assistant until one is made, then exactly one, however many times and at once", async () => {
  const { context, harness } = await setup();
  expect(await call(router.agents.assistant, undefined, { context })).toBeNull();
  const first = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context });
  const again = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context });
  const together = await Promise.all([ensureAssistant(context.db, context.ownerId, harness.id), ensureAssistant(context.db, context.ownerId, harness.id)]);
  for (const ids of [again, ...together]) expect(ids).toEqual(first);
  expect(await call(router.agents.assistant, undefined, { context })).toEqual(first);

  const rows = await context.db.select().from(agents).where(eq(agents.ownerId, context.ownerId));
  expect(rows).toEqual([expect.objectContaining({ id: first.agentId, name: "Assistant", builtIn: "assistant", bundles: ["data", "configure"], dataTables: "all", systemPrompt: "" })]);
  const made = await context.db.select().from(triggers).where(eq(triggers.agentId, first.agentId));
  expect(made).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: first.triggerId, kind: "manual", enabled: true, config: { kind: "manual", placement: "chat" } }),
      expect.objectContaining({ id: first.reviewTriggerId, kind: "schedule", enabled: false, builtIn: "review" }),
    ]),
  );
  expect(made).toHaveLength(2);
  expect(await call(router.agents.get, { id: first.agentId }, { context })).toMatchObject({ builtIn: "assistant" });
});

test("two at once make one Assistant even when the second doesn't see the first", async () => {
  const { context, harness } = await setup();
  await context.db.insert(agents).values({ id: "agent_made", ownerId: context.ownerId, name: "Assistant", harnessId: harness.id, systemPrompt: "", builtIn: "assistant" });
  // The partial unique index is what stops a second row.
  await expect(
    context.db.insert(agents).values({ id: "agent_twice", ownerId: context.ownerId, name: "Assistant", harnessId: harness.id, systemPrompt: "", builtIn: "assistant" }),
  ).rejects.toThrow();
  // An existing Assistant keeps its harness and gets the chat it lacked.
  const ids = await ensureAssistant(context.db, context.ownerId, harness.id);
  expect(ids.agentId).toBe("agent_made");
});

test("an Assistant is made only on one of the owner's own harnesses", async () => {
  const { context } = await setup();
  await expect(call(router.agents.ensureAssistant, { harnessId: "harness_someone_elses" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await call(router.agents.assistant, undefined, { context })).toBeNull();
});

test("no input makes or unmakes an Assistant: builtIn is in no agent schema", async () => {
  const { context, harness } = await setup();
  const made = await call(router.agents.create, { name: "Fake", harnessId: harness.id, systemPrompt: "", builtIn: "assistant" } as never, { context });
  expect(made).not.toHaveProperty("builtIn");
  expect(await call(router.agents.assistant, undefined, { context })).toBeNull();
  const ids = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context });
  const { skills } = await call(router.agents.get, { id: ids.agentId }, { context });
  const skillPackageIds = skills.map((s) => s.packageId);
  await call(router.agents.update, { id: ids.agentId, name: "Assistant", harnessId: harness.id, systemPrompt: "", skillPackageIds, builtIn: null } as never, { context });
  expect((await call(router.agents.get, { id: ids.agentId }, { context })).builtIn).toBe("assistant");
});

test("the owner can't delete the Assistant or strip its bundles, tables or chat", async () => {
  const { context, agentId, triggerId, fields } = await withAssistant();
  const refused = (p: Promise<unknown>, message: string) => expect(p).rejects.toMatchObject({ code: "FORBIDDEN", message });
  await refused(call(router.agents.delete, { id: agentId }, { context }), "The Assistant can't be deleted");
  await refused(call(router.agents.update, { ...fields, bundles: ["data"] }, { context }), "The Assistant keeps working on data and changing tables");
  await refused(call(router.agents.update, { ...fields, bundles: [] }, { context }), "The Assistant keeps working on data and changing tables");
  const { id: tableId } = await call(router.tables.create, { name: "Matters" }, { context });
  await refused(call(router.agents.update, { ...fields, dataTables: [tableId] }, { context }), "The Assistant keeps working on all tables");
  await refused(call(router.triggers.delete, { id: triggerId }, { context }), "The Assistant's chat can't be deleted");
  await refused(call(router.triggers.update, { id: triggerId, enabled: false }, { context }), "The Assistant's chat can't be turned off");
  await refused(call(router.triggers.update, { id: triggerId, config: { kind: "manual", placement: "button" } }, { context }), "The Assistant's chat stays a chat");

  const [row] = await context.db.select().from(agents).where(eq(agents.id, agentId));
  expect(row).toMatchObject({ bundles: ["data", "configure"], dataTables: "all" });
  expect((await context.db.select().from(triggers).where(eq(triggers.id, triggerId)))[0]).toMatchObject({ enabled: true, config: { kind: "manual", placement: "chat" } });
});

test("the owner changes the Assistant's name, harness, model and instructions, and its other triggers", async () => {
  const { context, agentId, triggerId, fields } = await withAssistant();
  const { runnerId } = await call(router.runners.create, { name: "Laptop" }, { context });
  const laptop = asCli(await call(router.harnesses.create, { name: "Codex", runnerId, kind: "codex", permissionMode: "default" }, { context }));
  const updated = await call(
    router.agents.update,
    { ...fields, name: "Concierge", harnessId: laptop.id, model: "sonnet", systemPrompt: "We are a law firm.", bundles: ["data", "configure", "inbox"], dataTables: "all" },
    { context },
  );
  expect(updated).toMatchObject({ name: "Concierge", harnessId: laptop.id, model: "sonnet", systemPrompt: "We are a law firm.", builtIn: "assistant" });
  await call(router.triggers.update, { id: triggerId, name: "Talk", instructions: "Be brief." }, { context });
  const button = await call(router.triggers.create, { agentId, name: "Review", instructions: "Review the workspace.", config: { kind: "manual", placement: "button" } }, { context });
  await call(router.triggers.update, { id: button.id, enabled: false }, { context });
  await call(router.triggers.delete, { id: button.id }, { context });
  // Another agent's chat is the owner's to remove.
  const other = await call(router.agents.create, { name: "Clerk", harnessId: laptop.id, systemPrompt: "" }, { context });
  const chat = await call(router.triggers.create, { agentId: other.id, name: "Chat", config: { kind: "manual", placement: "chat" } }, { context });
  await call(router.triggers.delete, { id: chat.id }, { context });
  await call(router.agents.delete, { id: other.id }, { context });
});

test("the Assistant's own Job can't propose stripping it: refused when proposed, with the reason", async () => {
  const { context, agentId, triggerId, fields } = await withAssistant();
  const job = { runId: (await call(router.jobs.start, { triggerId }, { context })).runId, ownerId: context.ownerId, agentId };
  const propose = (items: unknown) => callPlatformTool(context, job, "propose", { items });
  const errorOf = (result: unknown) => JSON.stringify(result);

  expect(errorOf(await propose([{ tool: "agents_update", input: { ...fields, bundles: ["data"] } }]))).toContain("Item 1 (agents_update): The Assistant keeps working on data and changing tables");
  expect(errorOf(await propose([{ tool: "agents_update", input: { ...fields, dataTables: [] } }]))).toContain("Item 1 (agents_update): The Assistant keeps working on all tables");
  expect(errorOf(await propose([{ tool: "triggers_delete", input: { id: triggerId } }]))).toContain("Item 1 (triggers_delete): The Assistant's chat can't be deleted");
  expect(errorOf(await propose([{ tool: "triggers_update", input: { id: triggerId, enabled: false } }]))).toContain("Item 1 (triggers_update): The Assistant's chat can't be turned off");
  expect(await context.db.select().from(proposals).where(eq(proposals.runId, job.runId))).toEqual([]);

  // What it may change is proposed as any write.
  const allowed = await propose([{ tool: "agents_update", input: { ...fields, systemPrompt: "We are a law firm.", bundles: ["data", "configure"], dataTables: "all" } }]);
  expect(errorOf(allowed)).toContain("proposalId");
  // An agent it proposes is never an Assistant: the schema drops the key.
  const made = await propose([{ tool: "agents_create", input: { name: "Fake", harnessId: fields.harnessId, systemPrompt: "", builtIn: "assistant" } }]);
  expect(errorOf(made)).toContain("proposalId");
  const items = (await context.db.select().from(proposals).where(eq(proposals.runId, job.runId))).flatMap((p) => p.items);
  expect(items.find((i) => i.tool === "agents_create")!.input).not.toHaveProperty("builtIn");
});

test("an Assistant Job's system prompt starts with the fixed text, then the owner's instructions", async () => {
  const { context, triggerId, fields } = await withAssistant();
  const promptOf = async () => {
    const { runId } = await call(router.jobs.start, { triggerId }, { context });
    return (await context.db.select().from(runs).where(eq(runs.id, runId)))[0]!.snapshot!.systemPrompt;
  };
  expect(await promptOf()).toBe(ASSISTANT_PROMPT);
  await call(router.agents.update, { ...fields, systemPrompt: "We are a law firm." }, { context });
  expect(await promptOf()).toBe(`${ASSISTANT_PROMPT}\n\nWe are a law firm.`);
  // Another agent's prompt is its own.
  const other = await call(router.agents.create, { name: "Clerk", harnessId: fields.harnessId, systemPrompt: "Be brief." }, { context });
  const chat = await call(router.triggers.create, { agentId: other.id, name: "Chat", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: chat.id }, { context });
  expect((await context.db.select().from(runs).where(eq(runs.id, runId)))[0]!.snapshot!.systemPrompt).toBe("Be brief.");
});

test("at start, every owner's Assistant gets the chat it lacks, on its own harness", async () => {
  const { context, harness } = await setup();
  await context.db.insert(agents).values({ id: "agent_old", ownerId: context.ownerId, name: "Assistant", harnessId: harness.id, systemPrompt: "", bundles: ["data", "configure"], builtIn: "assistant" });
  await ensureAssistants(context.db);
  const ids = await call(router.agents.assistant, undefined, { context });
  expect(ids).toEqual({ agentId: "agent_old", triggerId: expect.stringMatching(/^trigger_/), reviewTriggerId: expect.stringMatching(/^trigger_/) });
  await ensureAssistants(context.db);
  expect(await context.db.select().from(triggers).where(eq(triggers.agentId, "agent_old"))).toHaveLength(2);
});

test("the Assistant's review exists off, Mondays at 09:00, one at a time; the owner switches and edits it, never deletes it", async () => {
  const { context, harness, agentId, reviewTriggerId } = await withAssistant();
  const review = await call(router.triggers.get, { id: reviewTriggerId! }, { context });
  expect(review).toMatchObject({ name: "Review the workspace", kind: "schedule", enabled: false, concurrency: "one-at-a-time", config: { kind: "schedule", cron: "0 9 * * 1" } });
  expect(review.instructions).toContain("workspace_review");
  expect(review).not.toHaveProperty("nextFireAt");

  // The owner turns it on in their time zone: it is due next Monday at 09:00 there.
  const on = await call(router.triggers.update, { id: reviewTriggerId!, enabled: true, config: { kind: "schedule", cron: "0 9 * * 1", timezone: "America/New_York" } }, { context });
  expect(on).toMatchObject({ enabled: true, config: { timezone: "America/New_York" } });
  expect(on.nextFireAt).toBeInstanceOf(Date);
  await call(router.triggers.update, { id: reviewTriggerId!, name: "Monday review", instructions: "Look at the tables only." }, { context });
  // Made again at start, it stays as the owner left it, and is not doubled.
  await ensureAssistant(context.db, context.ownerId, harness.id);
  const rows = await context.db.select().from(triggers).where(eq(triggers.agentId, agentId));
  expect(rows.filter((t) => t.kind === "schedule")).toEqual([expect.objectContaining({ id: reviewTriggerId, name: "Monday review", enabled: true })]);

  await expect(call(router.triggers.delete, { id: reviewTriggerId! }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", message: "The Assistant's review can't be deleted: turn it off instead" });
  await call(router.triggers.update, { id: reviewTriggerId!, enabled: false }, { context });
  expect((await call(router.triggers.get, { id: reviewTriggerId! }, { context })).enabled).toBe(false);
  // Nor through a proposal.
  const { triggerId } = await call(router.agents.assistant, undefined, { context }).then((a) => a!);
  const job = { runId: (await call(router.jobs.start, { triggerId }, { context })).runId, ownerId: context.ownerId, agentId };
  const proposed = await callPlatformTool(context, job, "propose", { items: [{ tool: "triggers_delete", input: { id: reviewTriggerId } }] });
  expect(JSON.stringify(proposed)).toContain("The Assistant's review can't be deleted");
  // A schedule the owner adds to the Assistant is theirs to delete.
  const extra = await call(router.triggers.create, { agentId, name: "Daily", instructions: "Look.", config: { kind: "schedule", cron: "0 8 * * *", timezone: "Europe/Paris" } }, { context });
  await call(router.triggers.delete, { id: extra.id }, { context });
});
