import { call } from "@orpc/server";
import { expect, onTestFinished, test } from "vitest";
import { callPlatformTool, toolsOf, type JobIdentity } from "../platform/call.ts";
import type { Bundle, TableScope } from "../platform/bundles.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { MAX_MEMORY_ENTRIES, type MemoryTarget, PATH_RULE } from "./model.ts";
import { listMemory } from "./store.ts";

const entry = (path: string, body = "Body") => ({ path, name: `Name of ${path}`, description: `About ${path}`, type: "fact", body });
const notFound = { ok: false, error: "Not found" };

/** An agent with `bundles` on table t1 (of t1 and t2) learning into `selfLearning`, and a Job of it still going. */
async function setup(bundles: Bundle[] = ["data"], selfLearning: MemoryTarget[] = ["agent", "data", "workspace"], scope: (t1: string, t2: string) => TableScope = (t1) => [t1]) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const t1 = await call(router.tables.create, { name: "Clients" }, { context });
  const t2 = await call(router.tables.create, { name: "Matters" }, { context });
  const base = { name: "Clerk", harnessId: harness.id, systemPrompt: "" };
  const agent = await call(router.agents.create, { ...base, bundles, dataTables: scope(t1.id, t2.id), selfLearning }, { context });
  const other = await call(router.agents.create, { ...base, name: "Other" }, { context });
  const start = async (agentId: string) => {
    const trigger = await call(router.triggers.create, { agentId, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const job: JobIdentity = { runId, ownerId: context.ownerId, agentId };
    return { job, tool: (name: string, input: unknown = {}) => callPlatformTool(context, job, name, input) };
  };
  const { job, tool } = await start(agent.id);
  const setAgent = (patch: { bundles?: Bundle[]; dataTables?: TableScope; selfLearning?: MemoryTarget[] }) =>
    call(router.agents.update, { ...base, id: agent.id, bundles, dataTables: scope(t1.id, t2.id), selfLearning, ...patch }, { context });
  return { context, agent, other, job, t1, t2, tool, start, setAgent };
}

test("a Job writes each scope its targets name, and the write records its agent, run and configure", async () => {
  const { context, agent, job, t1, tool } = await setup();
  expect(await tool("memory_add", { scope: "workspace", ...entry("billing.md", "Monthly") })).toEqual({ ok: true, output: { path: "billing.md" } });
  expect(await tool("memory_add", { scope: "agent", ...entry("habits.md") })).toMatchObject({ ok: true });
  expect(await tool("memory_add", { scope: "table", tableId: t1.id, ...entry("acme.md") })).toMatchObject({ ok: true });
  const author = { type: "agent", agentId: agent.id, runId: job.runId, configure: false };
  for (const where of [{ scope: "workspace" as const }, { scope: "agent" as const, agentId: agent.id }, { scope: "table" as const, tableId: t1.id }]) {
    expect((await listMemory(context.db, context.ownerId, where)).map((e) => e.author)).toEqual([author]);
  }
  expect(await tool("memory_update", { scope: "workspace", ...entry("billing.md", "Quarterly") })).toMatchObject({ ok: true });
  expect(await tool("memory_read", { scope: "workspace", path: "billing.md" })).toMatchObject({
    ok: true,
    output: { body: "Quarterly", author: { type: "agent", agentId: agent.id, jobId: job.runId, configure: false }, accepted: false },
  });
  expect(await tool("memory_remove", { scope: "agent", path: "habits.md" })).toEqual({ ok: true, output: { path: "habits.md", removed: true } });
  expect(await tool("memory_remove", { scope: "agent", path: "habits.md" })).toEqual({ ok: false, error: "There is no entry habits.md." });
  expect(await listMemory(context.db, context.ownerId, { scope: "agent", agentId: agent.id })).toEqual([]);

  // A Job that configures the workspace writes with `configure`.
  const configurer = await setup(["data", "configure"], ["workspace"]);
  await configurer.tool("memory_add", { scope: "workspace", ...entry("a.md") });
  expect((await listMemory(configurer.context.db, configurer.context.ownerId, { scope: "workspace" }))[0]!.author).toMatchObject({ configure: true });
});

test("a write outside the Job's targets is refused with the target named", async () => {
  const { t1, tool } = await setup(["data"], ["agent"]);
  expect(await tool("memory_add", { scope: "workspace", ...entry("a.md") })).toEqual({ ok: false, error: "This agent may not write the workspace's memory: its self-learning doesn't include workspace." });
  expect(await tool("memory_add", { scope: "table", tableId: t1.id, ...entry("a.md") })).toEqual({ ok: false, error: "This agent may not write a table's memory: its self-learning doesn't include data." });
  const data = await setup(["data"], ["data"]);
  expect(await data.tool("memory_update", { scope: "agent", ...entry("a.md") })).toEqual({ ok: false, error: "This agent may not write its own memory: its self-learning doesn't include agent." });
  expect(await data.tool("memory_remove", { scope: "agent", path: "a.md" })).toEqual({ ok: false, error: "This agent may not write its own memory: its self-learning doesn't include agent." });
  // The data target without the data bundle writes no table.
  const noData = await setup(["configure"], ["data"], () => "all");
  expect(await noData.tool("memory_add", { scope: "table", tableId: noData.t1.id, ...entry("a.md") })).toEqual({ ok: false, error: "This agent may not write a table's memory: it doesn't work on data." });
});

test("a Job that learns nothing reads memory but has no write tool", async () => {
  const { context, job, tool } = await setup(["data"], []);
  const names = (await toolsOf(context.db, job)).map((t) => t.name);
  expect(names).toContain("memory_read");
  expect(names.filter((n) => n.startsWith("memory_"))).toEqual(["memory_read"]);
  expect(await tool("memory_add", { scope: "agent", ...entry("a.md") })).toEqual({ ok: false, error: "This agent may not use memory_add" });
  // Every Job reads, with no bundle at all.
  const bare = await setup([], []);
  expect((await toolsOf(bare.context.db, bare.job)).map((t) => t.name)).toEqual(["memory_read"]);
  expect(await bare.tool("memory_read", { scope: "workspace" })).toEqual({ ok: true, output: { entries: 0, index: "" } });
});

test("a table outside the Job's tables, or no table of the owner's, answers Not found", async () => {
  const { t2, tool } = await setup();
  expect(await tool("memory_add", { scope: "table", tableId: t2.id, ...entry("a.md") })).toEqual(notFound);
  expect(await tool("memory_read", { scope: "table", tableId: t2.id })).toEqual(notFound);
  expect(await tool("memory_remove", { scope: "table", tableId: t2.id, path: "a.md" })).toEqual(notFound);
  expect(await tool("memory_add", { scope: "table", ...entry("a.md") })).toEqual({ ok: false, error: "The table scope needs a tableId." });
  const all = await setup(["data"], ["data"], () => "all");
  expect(await all.tool("memory_add", { scope: "table", tableId: "table_nobody", ...entry("a.md") })).toEqual(notFound);
  expect(await all.tool("memory_read", { scope: "table", tableId: "table_nobody" })).toEqual(notFound);
  // A table's memory is read with `data` only.
  const noData = await setup(["configure"], [], () => "all");
  expect(await noData.tool("memory_read", { scope: "table", tableId: noData.t1.id })).toEqual(notFound);
});

test("memory_read gives another agent's memory only to a Job that configures the workspace", async () => {
  const { context, other, tool } = await setup(["data"]);
  await call(router.memories.write, { where: { scope: "agent", agentId: other.id }, entry: entry("x.md") }, { context });
  expect(await tool("memory_read", { scope: "agent", agentId: other.id })).toEqual(notFound);
  const configurer = await setup(["configure"]);
  await call(router.memories.write, { where: { scope: "agent", agentId: configurer.other.id }, entry: entry("x.md", "Secret sauce") }, { context: configurer.context });
  expect(await configurer.tool("memory_read", { scope: "agent", agentId: configurer.other.id })).toEqual({
    ok: true,
    output: { entries: 1, index: "Facts:\n- [Name of x.md](x.md): About x.md" },
  });
  expect(await configurer.tool("memory_read", { scope: "agent", agentId: configurer.other.id, path: "x.md" })).toMatchObject({ ok: true, output: { body: "Secret sauce", author: { type: "person" }, accepted: true } });
  expect(await configurer.tool("memory_read", { scope: "agent", agentId: "agent_nobody" })).toEqual(notFound);
  // Writes to the agent scope always land in the Job's own agent's memory.
  await configurer.tool("memory_add", { scope: "agent", agentId: configurer.other.id, ...entry("mine.md") });
  expect((await listMemory(configurer.context.db, configurer.context.ownerId, { scope: "agent", agentId: configurer.agent.id })).map((e) => e.path)).toEqual(["mine.md"]);
});

test("a path a CLI would load or that leaves the folder is refused as memories.write refuses it", async () => {
  const { context, tool } = await setup();
  for (const path of ["CLAUDE.md", "notes/claude.md", "x/AGENTS.override.md", ".claude/x.md", "../x.md", "/x.md", "a//b.md", "a\\b.md", "x.txt", "MEMORY.md", `${"a".repeat(118)}.md`]) {
    expect(await tool("memory_add", { scope: "workspace", ...entry(path), name: "Bad path" }), path).toEqual({ ok: false, error: PATH_RULE });
    await expect(call(router.memories.write, { where: { scope: "workspace" }, entry: { ...entry(path), name: "Bad path" } }, { context }), path).rejects.toMatchObject({ message: PATH_RULE });
  }
  expect(await tool("memory_add", { scope: "workspace", ...entry(`${"a".repeat(117)}.md`), name: "Longest path" })).toMatchObject({ ok: true });
});

test("the 101st entry of a memory is refused with the reason", async () => {
  const { tool } = await setup();
  for (let i = 0; i < MAX_MEMORY_ENTRIES; i++) expect(await tool("memory_add", { scope: "agent", ...entry(`e${i}.md`) })).toMatchObject({ ok: true });
  expect(await tool("memory_add", { scope: "agent", ...entry("one-more.md") })).toEqual({ ok: false, error: `This memory holds ${MAX_MEMORY_ENTRIES} entries already: remove one first.` });
});

test("rights taken back while the Job waits apply to its next write", async () => {
  const { t1, tool, setAgent } = await setup(["data"], ["agent", "data", "workspace"], () => "all");
  expect(await tool("memory_add", { scope: "workspace", ...entry("a.md") })).toMatchObject({ ok: true });
  await setAgent({ selfLearning: ["agent", "data"] });
  expect(await tool("memory_add", { scope: "workspace", ...entry("b.md") })).toEqual({ ok: false, error: "This agent may not write the workspace's memory: its self-learning doesn't include workspace." });
  expect(await tool("memory_add", { scope: "table", tableId: t1.id, ...entry("a.md") })).toMatchObject({ ok: true });
  await setAgent({ selfLearning: ["agent", "data"], dataTables: [] });
  expect(await tool("memory_add", { scope: "table", tableId: t1.id, ...entry("b.md") })).toEqual(notFound);
  await setAgent({ selfLearning: ["agent", "data"], bundles: [], dataTables: "all" });
  expect(await tool("memory_add", { scope: "table", tableId: t1.id, ...entry("b.md") })).toEqual({ ok: false, error: "This agent may not write a table's memory: it doesn't work on data." });
  await setAgent({ selfLearning: [], bundles: [] });
  expect(await tool("memory_add", { scope: "agent", ...entry("b.md") })).toEqual({ ok: false, error: "This agent may not use memory_add" });
  // Added back, a target never reaches the Job beyond its snapshot.
  await setAgent({ selfLearning: ["agent", "data", "workspace"], bundles: ["data"] });
  expect(await tool("memory_add", { scope: "workspace", ...entry("c.md") })).toMatchObject({ ok: true });
});

test("a target added after the Job was created is not the Job's", async () => {
  const { tool, setAgent } = await setup(["data"], ["agent"]);
  await setAgent({ selfLearning: ["agent", "workspace"] });
  expect(await tool("memory_add", { scope: "workspace", ...entry("a.md") })).toMatchObject({ ok: false });
});

test("two Jobs writing one path at once: one add lands, both updates are kept", async () => {
  const { context, agent, tool, start } = await setup(["data"], ["workspace"]);
  const second = await start(agent.id);
  const added = await Promise.all([tool("memory_add", { scope: "workspace", ...entry("a.md", "One") }), second.tool("memory_add", { scope: "workspace", ...entry("a.md", "Two") })]);
  expect(added.filter((r) => r.ok)).toHaveLength(1);
  expect(added.find((r) => !r.ok)).toEqual({ ok: false, error: "An entry a.md exists already." });
  await Promise.all([tool("memory_update", { scope: "workspace", ...entry("a.md", "Three") }), second.tool("memory_update", { scope: "workspace", ...entry("a.md", "Four") })]);
  const [row] = await listMemory(context.db, context.ownerId, { scope: "workspace" });
  const got = await call(router.memories.get, { id: row!.id }, { context });
  expect(got.revisions.map((r) => r.revision)).toEqual([3, 2, 1]);
  expect(got.body).toBe(got.revisions[0]!.body);
  expect(await tool("memory_update", { scope: "workspace", ...entry("b.md") })).toEqual({ ok: false, error: "There is no entry b.md." });
});

test("memory writes and reads are traced and counted by result, with no path, name or body", async () => {
  const { tool } = await setup(["data"], ["agent"]);
  const t = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  const secret = { path: "sentinel-path.md", name: "sentinel-name", description: "sentinel-description", type: "fact", body: "sentinel-body" };
  await tool("memory_add", { scope: "agent", ...secret });
  await tool("memory_add", { scope: "workspace", ...secret });
  await tool("memory_read", { scope: "agent", path: "sentinel-path.md" });
  await tool("memory_read", { scope: "agent", path: "sentinel-missing.md" });
  const points = await t.metrics();
  expect(points).toContainEqual({ name: "dispand.memory.writes", attributes: { "dispand.memory.scope": "agent", "dispand.memory.op": "add", "dispand.result": "ok" } });
  expect(points).toContainEqual({ name: "dispand.memory.writes", attributes: { "dispand.memory.scope": "workspace", "dispand.memory.op": "add", "dispand.result": "refused" } });
  expect(points).toContainEqual({ name: "dispand.memory.reads", attributes: { "dispand.memory.scope": "agent", "dispand.result": "ok" } });
  expect(points).toContainEqual({ name: "dispand.memory.reads", attributes: { "dispand.memory.scope": "agent", "dispand.result": "refused" } });
  expect(t.spans().find((s) => s.name === "memory.read")!.attributes).toMatchObject({ "dispand.memory.scope": "agent", "dispand.result": "ok" });
  expect(await t.all()).not.toContain("sentinel");
});
