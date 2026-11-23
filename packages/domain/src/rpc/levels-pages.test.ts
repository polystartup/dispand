import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { runnerWithClis, ownerContext, personContext } from "../runners/test-support.ts";
import { callPlatformTool } from "../platform/call.ts";
import { router } from "./router.ts";

test("levels › each member has their own pages, and puts on them what the workspace has, whoever made it", async () => {
  const owner = await ownerContext();
  const table = await call(router.tables.create, { name: "Clients" }, { context: owner });
  const workflow = await call(router.workflows.create, { name: "Onboard" }, { context: owner });
  const mine = await call(router.pages.create, { title: "Mine" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  const home = await call(router.pages.home, undefined, { context: pat });
  expect((await call(router.pages.list, undefined, { context: pat })).map((p) => p.id)).not.toContain(mine.id);
  await expect(call(router.pages.get, { id: mine.id }, { context: pat })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: workflow.id }, { context: pat });
  const [name] = (await call(router.tables.get, { id: table.id }, { context: pat })).fields;
  await call(router.widgets.create, { pageId: home.id, type: "table", tableId: table.id, config: { fieldIds: [name!.id] } }, { context: pat });
  expect((await call(router.pages.home, undefined, { context: pat })).widgets).toHaveLength(2);
});

test("levels › a member writes the workspace's memory and another member reads it", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "member");
  await call(router.memories.write, { where: { scope: "workspace" }, entry: { path: "clients.md", name: "Clients", description: "How clients pay", type: "fact", body: "Ada pays on time." } }, { context: pat });
  const listed = await call(router.memories.list, { scope: "workspace" }, { context: owner });
  expect(JSON.stringify(listed)).toContain("Ada pays on time.");
});

test("levels › a member neither reads nor writes another person's Assistant memory", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const { agentId } = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: owner });
  const where = { scope: "agent" as const, agentId };
  const entry = { path: "me.md", name: "Me", description: "About me", type: "fact" as const, body: "Private." };
  const { id } = await call(router.memories.write, { where, entry }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  const missing = { code: "NOT_FOUND" };
  await expect(call(router.memories.list, where, { context: pat })).rejects.toMatchObject(missing);
  await expect(call(router.memories.write, { where, entry: { ...entry, body: "Planted." } }, { context: pat })).rejects.toMatchObject(missing);
  await expect(call(router.memories.remove, { id }, { context: pat })).rejects.toMatchObject(missing);
});

test("levels › a configuring Job can't read another person's Assistant memory either", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: pat });
  const entry = { path: "me.md", name: "Me", description: "About me", type: "fact" as const, body: "Private." };
  await call(router.memories.write, { where: { scope: "agent", agentId: assistant.agentId }, entry }, { context: pat });
  await call(router.memories.write, { where: { scope: "workspace" }, entry: { ...entry, path: "shared.md", body: "Shared." } }, { context: pat });
  const agent = await call(router.agents.create, { name: "Builder", harnessId: harness.id, systemPrompt: "", bundles: ["configure"] }, { context: owner });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: owner });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: owner });
  const job = { runId, ownerId: owner.ownerId, workspaceId: owner.workspaceId, agentId: agent.id };
  // What the Job may read, it reads; another person's Assistant's, as if it weren't there.
  expect(await callPlatformTool(owner, job, "memory_read", { scope: "workspace", path: "shared.md" })).toMatchObject({ ok: true });
  expect(await callPlatformTool(owner, job, "memory_read", { scope: "agent", agentId: assistant.agentId, path: "me.md" })).toEqual({ ok: false, error: "Not found" });
});
