import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { runnerWithClis, jobIdentity, ownerContext, personContext } from "../runners/test-support.ts";
import { eq } from "drizzle-orm";
import { questions, runs, tools, triggers, workspaceMembers } from "../db/schema.ts";
import { router } from "./router.ts";

const forbidden = { code: "FORBIDDEN" };

test("levels › a member reads the workspace's harnesses, whoever made them, and can't create, change or delete one or set its limit", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.harnesses.list, undefined, { context: pat })).map((h) => h.id)).toEqual([harness.id]);
  await expect(call(router.harnesses.get, { id: harness.id }, { context: pat })).resolves.toMatchObject({ id: harness.id });
  expect((await call(router.harnesses.limits, undefined, { context: pat })).map((h) => h.id)).toEqual([harness.id]);
  await expect(call(router.harnesses.create, { name: "Mine", runnerId, kind: "codex", permissionMode: "default" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.harnesses.update, { id: harness.id, name: "Renamed", runnerId, kind: "claude-code", permissionMode: "default" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.harnesses.setLimit, { id: harness.id, maxWorking: 5 }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.harnesses.delete, { id: harness.id }, { context: pat })).rejects.toMatchObject(forbidden);
});

test("levels › a manager changes a harness another person made", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const mia = await personContext(owner, "mia", "manager");
  await expect(call(router.harnesses.setLimit, { id: harness.id, maxWorking: 5 }, { context: mia })).resolves.toMatchObject({ maxWorking: 5 });
  await expect(call(router.harnesses.update, { id: harness.id, name: "Renamed", runnerId, kind: "claude-code", permissionMode: "default" }, { context: mia })).resolves.toMatchObject({ name: "Renamed" });
});

test("levels › a member lists the workspace's runners, whoever registered them, and can't register, rename, revoke or update one, or install on it", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.runners.list, undefined, { context: pat })).map((r) => r.id)).toEqual([runnerId]);
  await expect(call(router.runners.create, { name: "Mine" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.update, { runnerId, name: "Renamed" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.revoke, { runnerId }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.installUpdate, { runnerId }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.plugins, { runnerId, operation: { action: "list" } }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.workspacePlugin, { harnessIds: [harness.id], resource: { kind: "skill", id: "x" }, action: "add", dryRun: true }, { context: pat })).rejects.toMatchObject(forbidden);
});

test("levels › a manager renames and revokes a runner another person registered, and can't install any plugin on it", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const mia = await personContext(owner, "mia", "manager");
  // Plugins run under the account of whoever installed the runner: only they install any there.
  await expect(call(router.runners.plugins, { runnerId, operation: { action: "list" } }, { context: mia })).rejects.toMatchObject(forbidden);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  await expect(call(router.runners.workspacePlugin, { harnessIds: [harness.id], resource: { kind: "skill", id: "x" }, action: "add", dryRun: true }, { context: mia })).rejects.toMatchObject(forbidden);
  await call(router.harnesses.delete, { id: harness.id }, { context: owner });
  await call(router.runners.update, { runnerId, name: "Renamed" }, { context: mia });
  await call(router.runners.revoke, { runnerId }, { context: mia });
  expect(await call(router.runners.list, undefined, { context: owner })).toEqual([]);
});

test("levels › a member reads the workspace's tools and connects one by OAuth, and can't add, change or delete one", async () => {
  const owner = await ownerContext();
  await owner.db.insert(tools).values({ id: "tool_mail", ownerId: owner.ownerId, workspaceId: owner.workspaceId, name: "Mail", kind: "http", url: "https://mail.example.com/mcp", transport: "streamable-http" });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.tools.list, undefined, { context: pat })).map((t) => t.id)).toEqual(["tool_mail"]);
  await expect(call(router.tools.get, { id: "tool_mail" }, { context: pat })).resolves.toMatchObject({ id: "tool_mail" });
  const http = { name: "Other", url: "https://other.example.com/mcp", transport: "streamable-http" as const, headers: {} };
  await expect(call(router.tools.create, http, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.add, { name: "Other", url: http.url, transport: http.transport }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.update, { id: "tool_mail", url: "https://elsewhere.example.com/mcp" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.fillSettings, { id: "tool_mail", settings: {} }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.addFromCatalog, { catalogId: "x" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.installFromCatalog, { catalogId: "x", settings: {} }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.delete, { id: "tool_mail" }, { context: pat })).rejects.toMatchObject(forbidden);
});

test("levels › a member makes, changes and deletes the workspace's skills, whoever made them", async () => {
  const owner = await ownerContext();
  const skill = { name: "writing", description: "Write well", instructions: "Be brief.", requiredToolIds: [] };
  const { packageId } = await call(router.skills.create, skill, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.skills.list, undefined, { context: pat })).map((p) => p.packageId)).toEqual([packageId]);
  await call(router.skills.update, { ...skill, packageId, description: "Write better" }, { context: pat });
  await call(router.skills.delete, { packageId }, { context: pat });
  expect(await call(router.skills.list, undefined, { context: owner })).toEqual([]);
});

test("levels › a member makes an agent on a manager's harness with a manager's tool, and another member changes and deletes it", async () => {
  const owner = await ownerContext();
  const mia = await personContext(owner, "mia", "manager");
  const { runnerId } = await runnerWithClis(mia);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: mia });
  await owner.db.insert(tools).values({ id: "tool_mail", ownerId: "mia", workspaceId: owner.workspaceId, name: "Mail", kind: "http", url: "https://mail.example.com/mcp", transport: "streamable-http" });
  const pat = await personContext(owner, "pat", "member");
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: ["tool_mail"] }, { context: pat });
  const sam = await personContext(owner, "sam", "member");
  await call(router.agents.update, { id: agent.id, name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief.", toolIds: [] }, { context: sam });
  await call(router.agents.delete, { id: agent.id }, { context: sam });
  expect(await call(router.agents.list, undefined, { context: owner })).toEqual([]);
});

test("levels › a member neither sees nor changes another person's Assistant", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const { agentId } = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.agents.list, undefined, { context: pat })).map((a) => a.id)).not.toContain(agentId);
  const missing = { code: "NOT_FOUND" };
  await expect(call(router.agents.get, { id: agentId }, { context: pat })).rejects.toMatchObject(missing);
  await expect(call(router.agents.update, { id: agentId, name: "Mine", harnessId: harness.id, systemPrompt: "" }, { context: pat })).rejects.toMatchObject(missing);
  await expect(call(router.agents.cliRules, { id: agentId }, { context: pat })).rejects.toMatchObject(missing);
  expect((await call(router.agents.list, undefined, { context: owner })).map((a) => a.id)).toContain(agentId);
});

test("levels › a member triggers and starts another person's agent, and sees its Jobs but not another person's Assistant chats", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context: owner });
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: owner });
  const chat = await call(router.jobs.start, { triggerId: assistant.triggerId }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: pat });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: pat });
  const seen = (await call(router.jobs.list, {}, { context: pat })).map((j) => j.id);
  expect(seen).toContain(runId);
  expect(seen).not.toContain(chat.runId);
  await expect(call(router.jobs.start, { triggerId: assistant.triggerId }, { context: pat })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.jobs.consults, { runId: chat.runId }, { context: pat })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Nor read, by its id, another person's Assistant chat, or its triggers.
  await expect(call(router.jobs.get, { id: chat.runId }, { context: pat })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.triggers.list, { agentId: assistant.agentId }, { context: pat })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.triggers.update, { id: assistant.triggerId, instructions: "Mine now." }, { context: pat })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // A trigger someone else made starts all the same, as the person who starts it.
  const button = await call(router.triggers.create, { agentId: agent.id, name: "Theirs", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: owner });
  const theirs = await call(router.jobs.start, { triggerId: button.id }, { context: pat });
  expect((await owner.db.select({ ownerId: runs.ownerId }).from(runs).where(eq(runs.id, theirs.runId)))[0]!.ownerId).toBe("pat");
  // Its Jobs run as whoever last changed it.
  await call(router.triggers.update, { id: button.id, instructions: "Work harder." }, { context: pat });
  expect((await owner.db.select({ ownerId: triggers.ownerId }).from(triggers).where(eq(triggers.id, button.id)))[0]!.ownerId).toBe("pat");
});

test("levels › a shared agent's Job, started by a person, can't read that person's Assistant chats", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: owner });
  const chat = await call(router.jobs.start, { triggerId: assistant.triggerId }, { context: owner });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", bundles: ["configure"] }, { context: owner });
  const button = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: owner });
  const { runId } = await call(router.jobs.start, { triggerId: button.id }, { context: owner });
  const job = { ...owner, job: { runId, ownerId: owner.ownerId, workspaceId: owner.workspaceId, agentId: agent.id } };
  await expect(call(router.jobs.get, { id: runId }, { context: job })).resolves.toMatchObject({ id: runId });
  await expect(call(router.jobs.get, { id: chat.runId }, { context: job })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("streams › a member removed mid-stream gets FORBIDDEN on the next event", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "member");
  const abort = new AbortController();
  const stream = await call(router.questions.stream, undefined, { context: pat, signal: abort.signal });
  try {
    expect((await stream.next()).value).toEqual({ count: 0 });
    await owner.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "pat"));
    owner.engine.questionChanges.publish("changed", true);
    await expect(stream.next()).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    abort.abort();
    await stream.return?.(undefined);
  }
});

test("levels › a member's Inbox holds what is addressed to them in the workspace, and they can't answer another's", async () => {
  const owner = await ownerContext();
  const job = await jobIdentity(owner);
  const pat = await personContext(owner, "pat", "member");
  const ask = (id: string, ownerId: string) => owner.db.insert(questions).values({ id, ownerId, addresseeId: ownerId, runId: job.runId, placement: "notifications", status: "pending", payload: { kind: "question", text: "Which?" } as never });
  await ask("q_pat", "pat");
  await ask("q_owner", owner.ownerId);
  expect((await call(router.questions.list, { status: "pending" }, { context: pat })).map((q) => q.id)).toEqual(["q_pat"]);
  expect(await call(router.questions.count, undefined, { context: pat })).toEqual({ count: 1 });
  await expect(call(router.questions.answer, { questionId: "q_owner", answer: { kind: "permission", decision: "allow" } }, { context: pat })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("levels › a member edits and starts another person's workflow, and the run is theirs", async () => {
  const owner = await ownerContext();
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.workflows.list, undefined, { context: pat })).map((w) => w.id)).toEqual([workflow.id]);
  const { def } = await call(router.workflows.get, { id: workflow.id }, { context: pat });
  await call(router.workflows.update, { id: workflow.id, name: "Ship it", def }, { context: pat });
  const { runId } = await call(router.runs.start, { workflowId: workflow.id }, { context: pat });
  expect((await owner.db.select({ ownerId: runs.ownerId }).from(runs).where(eq(runs.id, runId)))[0]!.ownerId).toBe("pat");
  // A workflow run stays its person's.
  expect((await call(router.runs.list, { workflowId: workflow.id }, { context: pat })).map((r) => r.id)).toEqual([runId]);
  expect(await call(router.runs.list, { workflowId: workflow.id }, { context: owner })).toEqual([]);
});
