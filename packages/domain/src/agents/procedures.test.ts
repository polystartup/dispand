import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { harnesses, tables as tablesTable, tools, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(
    await call(
      router.harnesses.create,
      { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" },
      { context },
    ),
  );
  return { context, harness };
}

test("agent create, get, list, update, delete", async () => {
  const { context, harness } = await setup();
  const created = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  expect(created).toEqual({
    id: expect.stringMatching(/^agent_/),
    ownerId: context.ownerId,
    name: "Writer",
    harnessId: harness.id,
    systemPrompt: "Be brief.",
    bundles: [],
    dataTables: "all",
    plugin: null,
  });
  expect(await call(router.agents.get, { id: created.id }, { context })).toEqual({ ...created, skills: [], tools: [] });
  expect(await call(router.agents.list, undefined, { context })).toEqual([created]);

  const updated = await call(
    router.agents.update,
    { id: created.id, name: "Editor", harnessId: harness.id, systemPrompt: "Be kind." },
    { context },
  );
  expect(updated).toEqual({ ...created, name: "Editor", systemPrompt: "Be kind." });
  expect(await call(router.agents.get, { id: created.id }, { context })).toEqual({ ...updated, skills: [], tools: [] });

  const withModel = await call(router.agents.update, { ...updated, model: " sonnet " }, { context });
  expect(withModel).toEqual({ ...updated, model: "sonnet" });
  expect(await call(router.agents.get, { id: created.id }, { context })).toEqual({ ...withModel, skills: [], tools: [] });
  const { id, name, harnessId, systemPrompt } = withModel;
  expect(await call(router.agents.update, { id, name, harnessId, systemPrompt }, { context })).toEqual(updated);

  await call(router.agents.delete, { id: created.id }, { context });
  expect(await call(router.agents.list, undefined, { context })).toEqual([]);
  await expect(call(router.agents.get, { id: created.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("cannot reference another owner's harness", async () => {
  const { context, harness } = await setup();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(harnesses).values({
    id: "harness_other",
    ownerId: "user_other",
    name: "Eve's",
    runnerId: harness.runnerId,
    kind: "claude-code",
    permissionMode: "default",
  });
  await expect(
    call(router.agents.create, { name: "A", harnessId: "harness_other", systemPrompt: "" }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const agent = await call(router.agents.create, { name: "A", harnessId: harness.id, systemPrompt: "" }, { context });
  await expect(
    call(router.agents.update, { id: agent.id, name: "A", harnessId: "harness_other", systemPrompt: "" }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("agent names are required", async () => {
  const { context, harness } = await setup();
  await expect(
    call(router.agents.create, { name: "  ", harnessId: harness.id, systemPrompt: "" }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("agent models are validated like the harness's", async () => {
  const { context, harness } = await setup();
  for (const model of ["", "  ", "x".repeat(101), "op\u0000us"]) {
    await expect(
      call(router.agents.create, { name: "A", harnessId: harness.id, systemPrompt: "", model }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
});

test("agent procedures require the owner's session", async () => {
  const context = { ...(await ownerContext()), headers: new Headers() };
  for (const procedure of [
    call(router.agents.list, undefined, { context }),
    call(router.agents.get, { id: "x" }, { context }),
    call(router.agents.create, { name: "A", harnessId: "x", systemPrompt: "" }, { context }),
    call(router.agents.update, { id: "x", name: "A", harnessId: "x", systemPrompt: "" }, { context }),
    call(router.agents.delete, { id: "x" }, { context }),
  ]) {
    await expect(procedure).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
});

/** Two HTTP tools of the owner, inserted as rows (no server needed to attach them). */
async function withTools(context: Awaited<ReturnType<typeof ownerContext>>) {
  for (const [id, name] of [["tool_gh", "GitHub"], ["tool_fc", "Firecrawl"]]) {
    await context.db.insert(tools).values({ id: id!, ownerId: context.ownerId, name: name!, kind: "http", url: "https://example.com/mcp", transport: "streamable-http" });
  }
}

async function skill(context: Awaited<ReturnType<typeof ownerContext>>, name: string, requiredToolIds: string[]) {
  const { packageId } = await call(router.skills.create, { name, description: `Does ${name}.`, instructions: "x", requiredToolIds }, { context });
  return packageId;
}

test("adding a skill adds its required tools, locked; removing the skill removes them", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  const review = await skill(context, "review", ["tool_gh"]);
  const agent = await call(router.agents.create, { name: "Reviewer", harnessId: harness.id, systemPrompt: "", skillPackageIds: [review] }, { context });
  const got = await call(router.agents.get, { id: agent.id }, { context });
  expect(got.skills).toEqual([{ packageId: review, name: "review" }]);
  expect(got.tools).toEqual([{ toolId: "tool_gh", name: "GitHub", kind: "http", explicit: false, lockedBy: ["review"] }]);

  const { id, name, harnessId, systemPrompt } = agent;
  await call(router.agents.update, { id, name, harnessId, systemPrompt, skillPackageIds: [] }, { context });
  expect(await call(router.agents.get, { id }, { context })).toMatchObject({ skills: [], tools: [] });
});

test("a tool both explicit and required stays after the skill is removed", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  const review = await skill(context, "review", ["tool_gh"]);
  const agent = await call(
    router.agents.create,
    { name: "Reviewer", harnessId: harness.id, systemPrompt: "", skillPackageIds: [review], toolIds: ["tool_gh", "tool_fc"] },
    { context },
  );
  expect((await call(router.agents.get, { id: agent.id }, { context })).tools).toEqual([
    { toolId: "tool_fc", name: "Firecrawl", kind: "http", explicit: true, lockedBy: [] },
    { toolId: "tool_gh", name: "GitHub", kind: "http", explicit: true, lockedBy: ["review"] },
  ]);
  const { id, name, harnessId, systemPrompt } = agent;
  await call(router.agents.update, { id, name, harnessId, systemPrompt, toolIds: ["tool_gh"] }, { context });
  const got = await call(router.agents.get, { id }, { context });
  expect(got.skills).toEqual([]);
  expect(got.tools).toEqual([{ toolId: "tool_gh", name: "GitHub", kind: "http", explicit: true, lockedBy: [] }]);
});

test("a skill's new required tool reaches the agents that have the skill", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  const review = await skill(context, "review", []);
  const agent = await call(router.agents.create, { name: "Reviewer", harnessId: harness.id, systemPrompt: "", skillPackageIds: [review] }, { context });
  await call(router.skills.update, { packageId: review, name: "review", description: "Does review.", instructions: "x", requiredToolIds: ["tool_fc"] }, { context });
  expect((await call(router.agents.get, { id: agent.id }, { context })).tools).toEqual([
    { toolId: "tool_fc", name: "Firecrawl", kind: "http", explicit: false, lockedBy: ["review"] },
  ]);
});

test("another owner's (or an unknown) skill or tool is NOT_FOUND, and nothing is saved", async () => {
  const { context, harness } = await setup();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tools).values({ id: "tool_eve", ownerId: "user_other", name: "Eve's", kind: "http", url: "https://example.com/mcp", transport: "streamable-http" });
  const base = { name: "A", harnessId: harness.id, systemPrompt: "" };
  for (const extra of [{ toolIds: ["tool_eve"] }, { toolIds: ["tool_missing"] }, { skillPackageIds: ["skillpkg_missing"] }]) {
    await expect(call(router.agents.create, { ...base, ...extra }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  expect(await call(router.agents.list, undefined, { context })).toEqual([]);
  const agent = await call(router.agents.create, base, { context });
  await expect(call(router.agents.update, { ...base, id: agent.id, name: "B", toolIds: ["tool_eve"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await call(router.agents.get, { id: agent.id }, { context })).toMatchObject({ name: "A", tools: [] });
});

test("tools.delete and skills.delete refused while an agent uses them", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  const review = await skill(context, "review", ["tool_gh"]);
  const agent = await call(router.agents.create, { name: "Reviewer", harnessId: harness.id, systemPrompt: "", skillPackageIds: [review], toolIds: ["tool_fc"] }, { context });
  await expect(call(router.skills.delete, { packageId: review }, { context })).rejects.toMatchObject({ code: "CONFLICT", message: "The agent “Reviewer” uses this skill" });
  await expect(call(router.tools.delete, { id: "tool_fc" }, { context })).rejects.toMatchObject({ code: "CONFLICT", message: "The agent “Reviewer” uses this tool" });
  // Required by a skill: every agent with the skill gets it.
  await expect(call(router.tools.delete, { id: "tool_gh" }, { context })).rejects.toMatchObject({ code: "CONFLICT", message: "The skill “review” requires this tool" });

  await call(router.agents.delete, { id: agent.id }, { context });
  await call(router.skills.delete, { packageId: review }, { context });
  await call(router.tools.delete, { id: "tool_gh" }, { context });
  await call(router.tools.delete, { id: "tool_fc" }, { context });
  expect(await call(router.tools.list, undefined, { context })).toEqual([]);
});

test("runner tool on a cloud harness, or on another runner than the harness's, refused; a skill's required ones too", async () => {
  const { context, harness } = await setup();
  const { runnerId: other } = await call(router.runners.create, { name: "Laptop" }, { context });
  for (const [id, runnerId] of [["tool_here", harness.runnerId], ["tool_there", other]]) {
    await context.db.insert(tools).values({ id: id!, ownerId: context.ownerId, name: id!, kind: "runner", runnerId, runnerTool: "fetch" });
  }
  const cloud = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context });
  const agent = (harnessId: string, extra: { toolIds?: string[]; skillPackageIds?: string[] }) =>
    call(router.agents.create, { name: "A", harnessId, systemPrompt: "", ...extra }, { context });

  expect(await agent(harness.id, { toolIds: ["tool_here"] })).toMatchObject({ harnessId: harness.id });
  await expect(agent(cloud.id, { toolIds: ["tool_here"] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Runner tools only work with CLI harnesses: “tool_here” runs on a runner" });
  await expect(agent(harness.id, { toolIds: ["tool_there"] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The tool “tool_there” runs on another runner than the agent's harness" });
  const fetcher = await skill(context, "fetcher", ["tool_there"]);
  await expect(agent(harness.id, { skillPackageIds: [fetcher] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The tool “tool_there” runs on another runner than the agent's harness" });
  // Update too.
  const plain = await agent(cloud.id, {});
  await expect(call(router.agents.update, { ...plain, toolIds: ["tool_here"] }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("an agent keeps its bundles and its tables; another owner's table is refused", async () => {
  const { context, harness } = await setup();
  const table = await call(router.tables.create, { name: "Clients" }, { context });
  const base = { name: "Clerk", harnessId: harness.id, systemPrompt: "" };
  const created = await call(router.agents.create, { ...base, bundles: ["data", "data"], dataTables: [table.id] }, { context });
  expect(created).toMatchObject({ bundles: ["data"], dataTables: [table.id] });

  const widened = await call(router.agents.update, { ...base, id: created.id, bundles: ["data", "configure"], dataTables: "all" }, { context });
  expect(widened).toMatchObject({ bundles: ["data", "configure"], dataTables: "all" });
  // An update that doesn't name them keeps them (the editor of an older client, a plugin update).
  expect(await call(router.agents.update, { ...base, id: created.id, name: "Renamed" }, { context })).toMatchObject({
    name: "Renamed",
    bundles: ["data", "configure"],
    dataTables: "all",
  });
  expect(await call(router.agents.get, { id: created.id }, { context })).toMatchObject({ bundles: ["data", "configure"], dataTables: "all" });

  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tablesTable).values({ id: "table_other", ownerId: "user_other", name: "Eve's" });
  await expect(call(router.agents.update, { ...base, id: created.id, dataTables: ["table_other"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND", message: "Table not found" });
  await expect(call(router.agents.create, { ...base, dataTables: ["table_nobody"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.agents.create, { ...base, bundles: ["admin"] as never }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
