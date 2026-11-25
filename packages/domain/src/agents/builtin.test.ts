import { call } from "@orpc/server";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import type { Db } from "../db/client.ts";
import { agents, agentSkills, memories, proposals, runs, skillPackages, triggers, workspaces } from "../db/schema.ts";
import { ASSISTANT_PROMPT } from "../engine/job-def.ts";
import { jobMemoryPrompt } from "../memory/read.ts";
import { callPlatformTool } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, approveAs, asCli, ownerContext } from "../runners/test-support.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "../workspace/authorize.ts";
import { ASSISTANT_BUNDLES, ensureAssistant, ensureAssistants } from "./builtin.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
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
  const together = await Promise.all([ensureAssistant(context.db, context.ownerId, harness.id, context.workspaceId), ensureAssistant(context.db, context.ownerId, harness.id, context.workspaceId)]);
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
  await context.db.insert(agents).values({ workspaceId: context.workspaceId, id: "agent_made", ownerId: context.ownerId, name: "Assistant", harnessId: harness.id, systemPrompt: "", builtIn: "assistant" });
  // The partial unique index is what stops a second row.
  await expect(
    context.db.insert(agents).values({ workspaceId: context.workspaceId, id: "agent_twice", ownerId: context.ownerId, name: "Assistant", harnessId: harness.id, systemPrompt: "", builtIn: "assistant" }),
  ).rejects.toThrow();
  // An existing Assistant keeps its harness and gets the chat it lacked.
  const ids = await ensureAssistant(context.db, context.ownerId, harness.id, context.workspaceId);
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
  await refused(call(router.agents.delete, { id: agentId }, { context }), "The Assistant can't be deleted.");
  await refused(call(router.agents.update, { ...fields, bundles: ["data"] }, { context }), "The Assistant keeps working on data and changing tables.");
  await refused(call(router.agents.update, { ...fields, bundles: [] }, { context }), "The Assistant keeps working on data and changing tables.");
  const { id: tableId } = await call(router.tables.create, { name: "Matters" }, { context });
  await refused(call(router.agents.update, { ...fields, dataTables: [tableId] }, { context }), "The Assistant keeps working on all tables.");
  await refused(call(router.triggers.delete, { id: triggerId }, { context }), "The Assistant's chat can't be deleted.");
  await refused(call(router.triggers.update, { id: triggerId, enabled: false }, { context }), "The Assistant's chat can't be turned off.");
  await refused(call(router.triggers.update, { id: triggerId, config: { kind: "manual", placement: "button" } }, { context }), "The Assistant's chat stays a chat.");

  const [row] = await context.db.select().from(agents).where(eq(agents.id, agentId));
  expect(row).toMatchObject({ bundles: ["data", "configure"], dataTables: "all" });
  expect((await context.db.select().from(triggers).where(eq(triggers.id, triggerId)))[0]).toMatchObject({ enabled: true, config: { kind: "manual", placement: "chat" } });
});

test("the owner changes the Assistant's name, harness, model and instructions, and its other triggers", async () => {
  const { context, agentId, triggerId, fields } = await withAssistant();
  const { runnerId } = await runnerWithClis(context, "Laptop");
  const laptop = asCli(await call(router.harnesses.create, { name: "Codex", runnerId, kind: "codex", permissionMode: "default" }, { context }));
  const updated = await call(
    router.agents.update,
    { ...fields, name: "Concierge", harnessId: laptop.id, model: "sonnet", systemPrompt: "We are a law firm.", bundles: ["data", "configure"], dataTables: "all" },
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
  const job = { runId: (await call(router.jobs.start, { triggerId }, { context })).runId, ownerId: context.ownerId, workspaceId: context.workspaceId, agentId };
  const propose = (items: unknown) => callPlatformTool(context, job, "propose", { items });
  const errorOf = (result: unknown) => JSON.stringify(result);

  expect(errorOf(await propose([{ tool: "agents_update", input: { ...fields, bundles: ["data"] } }]))).toContain("Item 1 (agents_update): The Assistant keeps working on data and changing tables");
  expect(errorOf(await propose([{ tool: "agents_update", input: { ...fields, dataTables: [] } }]))).toContain("Item 1 (agents_update): The Assistant keeps working on all tables");
  expect(errorOf(await propose([{ tool: "triggers_delete", input: { id: triggerId } }]))).toContain("Item 1 (triggers_delete): The Assistant's chat can't be deleted");
  expect(errorOf(await propose([{ tool: "triggers_update", input: { id: triggerId, enabled: false } }]))).toContain("Item 1 (triggers_update): The Assistant's chat can't be turned off");
  expect(errorOf(await propose([{ tool: "agents_delete", input: { id: agentId } }]))).toContain("Item 1 (agents_delete): The Assistant can't be deleted");
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
  await context.db.insert(agents).values({ workspaceId: context.workspaceId, id: "agent_old", ownerId: context.ownerId, name: "Assistant", harnessId: harness.id, systemPrompt: "", bundles: ["data", "configure"], builtIn: "assistant" });
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
  await ensureAssistant(context.db, context.ownerId, harness.id, context.workspaceId);
  const rows = await context.db.select().from(triggers).where(eq(triggers.agentId, agentId));
  expect(rows.filter((t) => t.kind === "schedule")).toEqual([expect.objectContaining({ id: reviewTriggerId, name: "Monday review", enabled: true })]);

  await expect(call(router.triggers.delete, { id: reviewTriggerId! }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", message: "The Assistant's review can't be deleted: turn it off instead." });
  await call(router.triggers.update, { id: reviewTriggerId!, enabled: false }, { context });
  expect((await call(router.triggers.get, { id: reviewTriggerId! }, { context })).enabled).toBe(false);
  // Nor through a proposal.
  const { triggerId } = await call(router.agents.assistant, undefined, { context }).then((a) => a!);
  const job = { runId: (await call(router.jobs.start, { triggerId }, { context })).runId, ownerId: context.ownerId, workspaceId: context.workspaceId, agentId };
  const proposed = await callPlatformTool(context, job, "propose", { items: [{ tool: "triggers_delete", input: { id: reviewTriggerId } }] });
  expect(JSON.stringify(proposed)).toContain("The Assistant's review can't be deleted");
  // A schedule the owner adds to the Assistant is theirs to delete.
  const extra = await call(router.triggers.create, { agentId, name: "Daily", instructions: "Look.", config: { kind: "schedule", cron: "0 8 * * *", timezone: "Europe/Paris" } }, { context });
  await call(router.triggers.delete, { id: extra.id }, { context });
});

test("Stem learns into the workspace's memory: made so, given so once by the migration, and the owner can untick it", async () => {
  const { context, agentId, fields } = await withAssistant();
  expect((await call(router.agents.get, { id: agentId }, { context })).selfLearning).toEqual(["workspace"]);
  // Not locked by the guard: the owner turns it off, and a start doesn't turn it on again.
  await call(router.agents.update, { ...fields, selfLearning: [] }, { context });
  await ensureAssistants(context.db);
  expect((await call(router.agents.get, { id: agentId }, { context })).selfLearning).toEqual([]);

  // A Stem from before (no target): the migration gives it `workspace`; one whose owner set a target keeps it.
  const migrate = () => context.db.execute(sql.raw(readFileSync(new URL("../../drizzle/0080_stem_workspace_memory.sql", import.meta.url), "utf8")));
  const learning = async () => (await context.db.select({ selfLearning: agents.selfLearning }).from(agents).where(eq(agents.id, agentId)))[0]!.selfLearning;
  await migrate();
  expect(await learning()).toEqual(["workspace"]);
  await context.db.update(agents).set({ selfLearning: ["agent"] }).where(eq(agents.id, agentId));
  await migrate();
  expect(await learning()).toEqual(["agent"]);
});

test("the day-one proposal's memory_add, approved and applied, writes the business authored by Stem's Job, and its next Job reads it", async () => {
  const { context, agentId, triggerId } = await withAssistant();
  const start = async () => ({ runId: (await call(router.jobs.start, { triggerId }, { context })).runId, ownerId: context.ownerId, workspaceId: context.workspaceId, agentId });
  const job = await start();
  const business = { scope: "workspace", path: "business.md", name: "How the firm works", description: "A law firm: client emails, matters, research and drafted replies", type: "business", body: "SENTINEL-BUSINESS: a law firm." };
  const proposed = (await callPlatformTool(context, job, "propose", { items: [{ tool: "tables_create", input: { name: "Matters" } }, { tool: "memory_add", input: business }] })) as { output: { proposalId: string } };
  const { proposalId } = proposed.output;
  await approveAs(context.db, proposalId, context.ownerId);
  expect(await callPlatformTool(context, job, "proposal_apply", { proposalId })).toMatchObject({ ok: true, output: { items: [{ outcome: "made" }, { outcome: "made" }], next: "Every item is made." } });
  // The item is used: applied again, it is not written twice.
  expect(await callPlatformTool(context, job, "proposal_apply", { proposalId })).toMatchObject({ ok: true, output: { items: [{ outcome: "made before" }, { outcome: "made before" }] } });

  const [entry] = await context.db.select().from(memories).where(eq(memories.ownerId, context.ownerId));
  expect(entry).toMatchObject({ scope: "workspace", path: "business.md", type: "business", author: { type: "agent", agentId, runId: job.runId, configure: true } });
  const next = await start();
  const [run] = await context.db.select().from(runs).where(eq(runs.id, next.runId));
  expect((await jobMemoryPrompt(context.db, run!)).prompt).toContain("SENTINEL-BUSINESS: a law firm.");
  expect((await call(router.agents.get, { id: agentId }, { context })).systemPrompt).toBe("");
});

test("a memory_add outside the Job's learning targets is refused when proposed, with the reason", async () => {
  const { context, agentId, triggerId, fields } = await withAssistant();
  await call(router.agents.update, { ...fields, selfLearning: ["agent"] }, { context });
  const job = { runId: (await call(router.jobs.start, { triggerId }, { context })).runId, ownerId: context.ownerId, workspaceId: context.workspaceId, agentId };
  const entry = { path: "business.md", name: "Business", description: "How it works", type: "business", body: "A law firm." };
  expect(await callPlatformTool(context, job, "propose", { items: [{ tool: "memory_add", input: { ...entry, scope: "workspace" } }] })).toEqual({
    ok: false,
    error: "Item 1 (memory_add): This agent may not write the workspace's memory: its self-learning doesn't include workspace.",
  });
  expect(await context.db.select().from(proposals).where(eq(proposals.runId, job.runId))).toEqual([]);
  expect(await callPlatformTool(context, job, "propose", { items: [{ tool: "memory_add", input: { ...entry, scope: "agent" } }] })).toMatchObject({ ok: true });
});

/** The owner of an organization with two workspaces, their requests in each, and a harness in each. */
async function twoWorkspaces() {
  const first = await setup();
  const { db, organizationId, ownerId } = first.context;
  await db.insert(workspaces).values({ id: "ws_b", organizationId });
  const inWorkspace = async (workspaceId: string) => {
    const context = { ...first.context, workspaceId, headers: new Headers({ cookie: first.context.headers.get("cookie")!, [ORGANIZATION_HEADER]: organizationId, [WORKSPACE_HEADER]: workspaceId }) };
    const { runnerId } = await runnerWithClis(context);
    const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
    return { context, harness };
  };
  return { db, ownerId, a: await inWorkspace(first.context.workspaceId), b: await inWorkspace("ws_b") };
}

/**
 * Keeps `agents` to the workspace `work` runs for, as a database adapter keeping rows to the workspace in scope does:
 * row security, for a role that doesn't own the table (the tests' own login bypasses it).
 */
async function confineAgents(db: Db) {
  onTestFinished(async () => {
    await db.execute(sql`reset role`);
    await db.execute(sql`drop policy if exists in_workspace on agents`);
    await db.execute(sql`alter table agents disable row level security`);
  });
  await db.execute(sql`do $$ begin create role confined; exception when duplicate_object then null; end $$`);
  await db.execute(sql`grant usage on schema public to confined`);
  await db.execute(sql`grant all on all tables in schema public to confined`);
  await db.execute(sql`grant all on all sequences in schema public to confined`);
  await db.execute(sql`alter table agents enable row level security`);
  await db.execute(sql`create policy in_workspace on agents using (workspace_id = current_setting('test.workspace')) with check (workspace_id = current_setting('test.workspace'))`);
  return async <T>(workspaceId: string, work: () => Promise<T>): Promise<T> => {
    await db.execute(sql`select set_config('test.workspace', ${workspaceId}, false)`);
    await db.execute(sql`set role confined`);
    try {
      return await work();
    } finally {
      await db.execute(sql`reset role`);
    }
  };
}

test("a person in two workspaces gets one Assistant in each, made once per workspace however many times and at once", async () => {
  const { db, ownerId, a, b } = await twoWorkspaces();
  const inA = await call(router.agents.ensureAssistant, { harnessId: a.harness.id }, { context: a.context });
  expect(await call(router.agents.assistant, undefined, { context: b.context })).toBeNull();
  expect(await call(router.onboarding.status, undefined, { context: b.context })).toMatchObject({ assistant: null });

  const inB = await call(router.agents.ensureAssistant, { harnessId: b.harness.id }, { context: b.context });
  expect(inB.agentId).not.toBe(inA.agentId);
  const again = await call(router.agents.ensureAssistant, { harnessId: b.harness.id }, { context: b.context });
  const together = await Promise.all([ensureAssistant(db, ownerId, b.harness.id, "ws_b"), ensureAssistant(db, ownerId, b.harness.id, "ws_b")]);
  for (const ids of [again, ...together]) expect(ids).toEqual(inB);
  expect(await call(router.agents.ensureAssistant, { harnessId: a.harness.id }, { context: a.context })).toEqual(inA);

  for (const [w, ids] of [[a, inA], [b, inB]] as const) {
    expect(await call(router.agents.assistant, undefined, { context: w.context })).toEqual(ids);
    expect(await call(router.onboarding.status, undefined, { context: w.context })).toMatchObject({ assistant: { agentId: ids.agentId } });
    // Its platform skill is its workspace's.
    const skills = await db.select({ workspaceId: skillPackages.workspaceId }).from(agentSkills).innerJoin(skillPackages, eq(skillPackages.id, agentSkills.packageId)).where(eq(agentSkills.agentId, ids.agentId));
    expect(skills).toEqual([{ workspaceId: w.context.workspaceId }]);
  }
  const rows = await db.select({ id: agents.id, workspaceId: agents.workspaceId, harnessId: agents.harnessId }).from(agents).where(and(eq(agents.ownerId, ownerId), eq(agents.builtIn, "assistant")));
  expect(rows).toHaveLength(2);
  expect(rows).toEqual(expect.arrayContaining([{ id: inA.agentId, workspaceId: a.context.workspaceId, harnessId: a.harness.id }, { id: inB.agentId, workspaceId: "ws_b", harnessId: b.harness.id }]));
});

test("with rows kept to the workspace in scope, the second workspace gets its own Assistant, not an internal error", async () => {
  const { db, a, b } = await twoWorkspaces();
  const confined = await confineAgents(db);
  const inA = await confined(a.context.workspaceId, () => call(router.agents.ensureAssistant, { harnessId: a.harness.id }, { context: a.context }));
  expect(await confined("ws_b", () => call(router.agents.assistant, undefined, { context: b.context }))).toBeNull();
  const inB = await confined("ws_b", () => call(router.agents.ensureAssistant, { harnessId: b.harness.id }, { context: b.context }));
  expect(inB.agentId).not.toBe(inA.agentId);
  expect(await confined("ws_b", () => call(router.agents.ensureAssistant, { harnessId: b.harness.id }, { context: b.context }))).toEqual(inB);
  expect(await confined("ws_b", () => call(router.agents.assistant, undefined, { context: b.context }))).toEqual(inB);
  expect(await confined(a.context.workspaceId, () => call(router.agents.assistant, undefined, { context: a.context }))).toEqual(inA);
});

test("at start, a person's Assistant in each workspace gets what it lacks, there", async () => {
  const { db, ownerId, a, b } = await twoWorkspaces();
  const bare = (id: string, w: typeof a) => ({ id, workspaceId: w.context.workspaceId, ownerId, name: "Assistant", harnessId: w.harness.id, systemPrompt: "", bundles: ASSISTANT_BUNDLES, builtIn: "assistant" as const });
  await db.insert(agents).values([bare("agent_a", a), bare("agent_b", b)]);
  await ensureAssistants(db);
  expect(await call(router.agents.assistant, undefined, { context: a.context })).toMatchObject({ agentId: "agent_a" });
  expect(await call(router.agents.assistant, undefined, { context: b.context })).toMatchObject({ agentId: "agent_b" });
  for (const id of ["agent_a", "agent_b"]) expect(await db.select().from(triggers).where(eq(triggers.agentId, id))).toHaveLength(2);
});
