import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { agents as agentsTable, agentTools, harnesses, tables as tablesTable, tools, user } from "../db/schema.ts";
import { PLATFORM_TOOLS } from "../platform/tools.ts";
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
    description: "",
    harnessId: harness.id,
    systemPrompt: "Be brief.",
    bundles: [],
    dataTables: "all",
    selfLearning: [],
    plugin: null,
  });
  expect(await call(router.agents.get, { id: created.id }, { context })).toEqual({ ...created, skills: [], tools: [], consults: [] });
  expect(await call(router.agents.list, undefined, { context })).toEqual([created]);

  const updated = await call(
    router.agents.update,
    { id: created.id, name: "Editor", harnessId: harness.id, systemPrompt: "Be kind." },
    { context },
  );
  expect(updated).toEqual({ ...created, name: "Editor", systemPrompt: "Be kind." });
  expect(await call(router.agents.get, { id: created.id }, { context })).toEqual({ ...updated, skills: [], tools: [], consults: [] });

  const withModel = await call(router.agents.update, { ...updated, model: " sonnet " }, { context });
  expect(withModel).toEqual({ ...updated, model: "sonnet" });
  expect(await call(router.agents.get, { id: created.id }, { context })).toEqual({ ...withModel, skills: [], tools: [], consults: [] });
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
  expect(await call(router.agents.get, { id }, { context })).toMatchObject({ skills: [], tools: [], consults: [] });
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

test("an agent keeps its bundles and its tables; another owner's table is never granted", async () => {
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
  // A table that isn't the owner's is never granted: it is left out, as a table deleted since is,
  // so an agent whose list names a deleted table can still be saved.
  expect(await call(router.agents.update, { ...base, id: created.id, dataTables: ["table_other", table.id, "table_nobody"] }, { context })).toMatchObject({ dataTables: [table.id] });
  expect(await call(router.agents.create, { ...base, name: "Other", dataTables: ["table_nobody"] }, { context })).toMatchObject({ dataTables: [] });
  await expect(call(router.agents.create, { ...base, bundles: ["admin"] as never }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a tool added to an agent starts with its read-only actions unasked, and only a person's change moves that", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  const action = (name: string, readOnly?: true) => ({ name, description: "", inputSchema: { type: "object" }, ...(readOnly ? { readOnly } : {}) });
  await context.db.update(tools).set({ actions: [action("search", true), action("send")] }).where(eq(tools.id, "tool_gh"));
  const agent = await call(router.agents.create, { name: "Reviewer", harnessId: harness.id, systemPrompt: "", toolIds: ["tool_gh"] }, { context });
  const unasked = async (toolId: string) =>
    (await context.db.select({ unasked: agentTools.unasked }).from(agentTools).where(and(eq(agentTools.agentId, agent.id), eq(agentTools.toolId, toolId))))[0]?.unasked;
  expect(await unasked("tool_gh")).toEqual(["search"]);

  // The owner's list is kept when the agent is saved again, and a tool added then starts on its own.
  await context.db.update(agentTools).set({ unasked: [] }).where(eq(agentTools.agentId, agent.id));
  const { id, name, harnessId, systemPrompt } = agent;
  await call(router.agents.update, { id, name, harnessId, systemPrompt, toolIds: ["tool_gh", "tool_fc"] }, { context });
  expect(await unasked("tool_gh")).toEqual([]);
  expect(await unasked("tool_fc")).toEqual([]);

  // The tool's server now calls `send` read-only: its claim grants nothing on an agent that has the tool.
  await context.db.update(tools).set({ actions: [action("search", true), action("send", true)] }).where(eq(tools.id, "tool_gh"));
  await call(router.agents.update, { id, name, harnessId, systemPrompt, toolIds: ["tool_gh"] }, { context });
  expect(await unasked("tool_gh")).toEqual([]);
});

test("the owner takes an action off the asking ones and puts it back; nothing else can", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  const action = (name: string, readOnly?: true) => ({ name, description: `Does ${name}`, inputSchema: { type: "object" }, ...(readOnly ? { readOnly } : {}) });
  await context.db.update(tools).set({ actions: [action("search", true), action("send")] }).where(eq(tools.id, "tool_gh"));
  const review = await skill(context, "review", ["tool_fc"]);
  const agent = await call(router.agents.create, { name: "Reviewer", harnessId: harness.id, systemPrompt: "", skillPackageIds: [review], toolIds: ["tool_gh"] }, { context });
  const asks = async () => (await call(router.agents.toolAsk, { id: agent.id }, { context })).find((t) => t.toolId === "tool_gh")!.actions;
  expect(await asks()).toEqual([
    { name: "search", description: "Does search", readOnly: true, permission: "run" },
    { name: "send", description: "Does send", readOnly: false, permission: "ask" },
  ]);

  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_gh", action: "send", permission: "run" }, { context });
  expect((await asks()).map((a) => a.permission)).toEqual(["run", "run"]);
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_gh", action: "search", permission: "ask" }, { context });
  expect((await asks()).map((a) => a.permission)).toEqual(["ask", "run"]);

  // An action the tool doesn't list, a tool that only comes with a skill, a tool the agent doesn't have, another owner's agent.
  for (const input of [
    { agentId: agent.id, toolId: "tool_gh", action: "delete" },
    { agentId: agent.id, toolId: "tool_fc", action: "search" },
    { agentId: agent.id, toolId: "tool_missing", action: "search" },
  ]) {
    await expect(call(router.agents.setToolPermission, { ...input, permission: "run" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(agentsTable).values({ id: "agent_eve", ownerId: "user_other", name: "Eve's", harnessId: harness.id, systemPrompt: "" });
  await context.db.insert(agentTools).values({ agentId: "agent_eve", toolId: "tool_gh" });
  await expect(call(router.agents.setToolPermission, { agentId: "agent_eve", toolId: "tool_gh", action: "search", permission: "run" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.agents.toolAsk, { id: "agent_eve" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });

  // An action the tool no longer lists grants nothing, and leaves the list at the next change.
  await context.db.update(tools).set({ actions: [action("search", true)] }).where(eq(tools.id, "tool_gh"));
  expect(await asks()).toEqual([{ name: "search", description: "Does search", readOnly: true, permission: "ask" }]);
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_gh", action: "search", permission: "run" }, { context });
  const [row] = await context.db.select({ unasked: agentTools.unasked }).from(agentTools).where(and(eq(agentTools.agentId, agent.id), eq(agentTools.toolId, "tool_gh")));
  expect(row!.unasked).toEqual(["search"]);
});

test("a Job changes the asking flags only on a proposal a person approved: the write is marked as a grant", () => {
  expect(PLATFORM_TOOLS.find((t) => t.path === "agents.setToolPermission")).toMatchObject({ bundle: "configure", grant: true });
  expect(PLATFORM_TOOLS.find((t) => t.path === "agents.toolAsk")?.grant).toBeUndefined();
});

test("runner catalog defaults survive late discovery and the approved backfill preserves other grants", async () => {
  const { context, harness } = await setup();
  const entries = [
    { id: "mail_empty", name: "Mail empty", kind: "runner" as const, catalogId: "gmail-runner", runnerId: harness.runnerId, runnerTool: "gmail" },
    { id: "mail_kept", name: "Mail kept", kind: "runner" as const, catalogId: "gmail-runner", runnerId: harness.runnerId, runnerTool: "gmail" },
    { id: "mail_http", name: "Mail HTTP", kind: "http" as const, catalogId: "gmail-runner", url: "https://example.com/mcp", transport: "streamable-http" as const },
  ];
  await context.db.insert(tools).values(entries.map((t) => ({ ...t, ownerId: context.ownerId })));
  const agent = await call(router.agents.create, { name: "Drafter", harnessId: harness.id, systemPrompt: "", toolIds: entries.map((t) => t.id) }, { context });
  const grants = async () => context.db.select().from(agentTools).where(eq(agentTools.agentId, agent.id));
  expect((await grants()).find((t) => t.toolId === "mail_empty")!.unasked).toContain("draft_email");
  await context.db.update(agentTools).set({ unasked: [] }).where(eq(agentTools.agentId, agent.id));
  await context.db.update(agentTools).set({ unasked: ["read_email"] }).where(and(eq(agentTools.agentId, agent.id), eq(agentTools.toolId, "mail_kept")));
  await context.db.execute(sql.raw(readFileSync(new URL("../../drizzle/0062_fill_catalog_runner_unasked.sql", import.meta.url), "utf8")));
  const rows = await grants();
  expect(rows.find((t) => t.toolId === "mail_empty")!.unasked).toContain("draft_email");
  expect(rows.find((t) => t.toolId === "mail_empty")!.unasked).not.toContain("send_email");
  expect(rows.find((t) => t.toolId === "mail_kept")!.unasked).toEqual(["read_email"]);
  expect(rows.find((t) => t.toolId === "mail_http")!.unasked).toEqual([]);
  await context.db.update(tools).set({ actions: ["draft_email", "send_email"].map((name) => ({ name, description: "", inputSchema: { type: "object" } })) }).where(eq(tools.id, "mail_empty"));
  const listed = await call(router.agents.toolAsk, { id: agent.id }, { context });
  expect(listed.find((t) => t.toolId === "mail_empty")!.actions.map((a) => a.permission)).toEqual(["run", "ask"]);
});


test("an action can be off, ask, or run; re-enabling an off read-only action asks", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  await context.db.update(tools).set({ actions: [{ name: "read", description: "Read", inputSchema: {}, readOnly: true }] }).where(eq(tools.id, "tool_gh"));
  const agent = await call(router.agents.create, { name: "Reader", harnessId: harness.id, systemPrompt: "", toolIds: ["tool_gh"] }, { context });
  const change = (permission: "run" | "ask" | "off") => call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_gh", action: "read", permission }, { context });
  const read = async () => (await call(router.agents.toolAsk, { id: agent.id }, { context }))[0]!.actions[0]!.permission;
  expect(await read()).toBe("run");
  await change("off");
  expect(await read()).toBe("off");
  const { rememberAllowedAction } = await import("./tool-ask.ts");
  expect(await rememberAllowedAction(context.db, context.ownerId, { agentId: agent.id, toolId: "tool_gh", action: "read" })).toBe(false);
  expect(await read()).toBe("off");
  await change("ask");
  expect(await read()).toBe("ask");
  await change("run");
  expect(await read()).toBe("run");
});

test("unrelated agent updates preserve off actions and cannot restore them through unasked lists", async () => {
  const { context, harness } = await setup();
  await withTools(context);
  await context.db.update(tools).set({ actions: ["read", "send"].map((name) => ({ name, description: name, inputSchema: {} })) }).where(eq(tools.id, "tool_gh"));
  const fields = { name: "Mail", harnessId: harness.id, systemPrompt: "", toolIds: ["tool_gh"] };
  const agent = await call(router.agents.create, { ...fields, toolPermissions: [{ toolId: "tool_gh", unasked: ["read"] }] }, { context });
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_gh", action: "send", permission: "off" }, { context });
  await call(router.agents.update, { ...fields, id: agent.id, name: "Renamed", systemPrompt: "Updated" }, { context });
  const saved = async () => (await context.db.select().from(agentTools).where(eq(agentTools.agentId, agent.id)))[0]!;
  expect(await saved()).toMatchObject({ unasked: ["read"], denied: ["send"] });
  await expect(call(router.agents.update, { ...fields, id: agent.id, toolPermissions: [{ toolId: "tool_gh", unasked: ["send"] }] }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await saved()).toMatchObject({ unasked: ["read"], denied: ["send"] });
});
