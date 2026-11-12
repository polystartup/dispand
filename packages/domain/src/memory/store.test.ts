import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { memories, memoryRevisions } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { MAX_MEMORY_ENTRIES, type MemoryAuthor, PATH_RULE } from "./model.ts";
import { acceptMemory, listMemory, memoryIndex, removeMemory, restoreMemory, revertMemory, writeMemory } from "./store.ts";

const entry = (path: string, body = "Body", type = "fact") => ({ path, name: `Name of ${path}`, description: `About ${path}`, type, body });

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { harnessId: harness.id, systemPrompt: "", skillPackageIds: [], toolIds: [], name: "Clerk", bundles: ["data"] }, { context });
  const table = await call(router.tables.create, { name: "Clients" }, { context });
  const agentAuthor: MemoryAuthor = { type: "agent", agentId: agent.id, runId: "run_1", configure: false };
  return { context, db: context.db, ownerId: context.ownerId, agent, table, agentAuthor };
}

test("owner's procedures add, update, remove and list an entry in every scope", async () => {
  const { context, agent, table } = await setup();
  for (const where of [{ scope: "workspace" as const }, { scope: "table" as const, tableId: table.id }, { scope: "agent" as const, agentId: agent.id }]) {
    const { id } = await call(router.memories.write, { where, entry: entry("clients/acme.md", "First") }, { context });
    await call(router.memories.write, { where, entry: entry("clients/acme.md", "Second") }, { context });
    await call(router.memories.write, { where, entry: entry("billing.md", "Monthly", "business") }, { context });
    const listed = await call(router.memories.list, where, { context });
    expect(listed.entries.map((e) => [e.path, e.body, e.author])).toEqual([
      ["billing.md", "Monthly", { type: "user" }],
      ["clients/acme.md", "Second", { type: "user" }],
    ]);
    expect(listed.index).toBe("How the business works:\n- [Name of billing.md](billing.md): About billing.md\n\nFacts:\n- [Name of clients/acme.md](clients/acme.md): About clients/acme.md");
    const got = await call(router.memories.get, { id }, { context });
    expect(got.revisions.map((r) => [r.revision, r.body])).toEqual([
      [2, "Second"],
      [1, "First"],
    ]);
    await call(router.memories.remove, { id }, { context });
    const after = await call(router.memories.list, where, { context });
    expect(after.entries.map((e) => e.path)).toEqual(["billing.md"]);
    expect(after.removed.map((e) => e.path)).toEqual(["clients/acme.md"]);
  }
  // Scopes are apart: each holds its own two entries.
  expect(await context.db.select().from(memories)).toHaveLength(6);
});

test("paths an agent or a person may try are refused with the path rule; a 101st entry with the cap", async () => {
  const { context, db, ownerId, agentAuthor } = await setup();
  const where = { scope: "workspace" as const };
  const tries = ["CLAUDE.md", "notes/claude.md", "x/AGENTS.override.md", ".claude/x.md", "../x.md", "/x.md", "a//b.md", "a\\b.md", "x.txt", "MEMORY.md", `${"a".repeat(118)}.md`];
  for (const path of tries) {
    await expect(call(router.memories.write, { where, entry: entry(path) }, { context }), path).rejects.toMatchObject({ code: "BAD_REQUEST", message: PATH_RULE });
    expect(await writeMemory(db, ownerId, where, entry(path), agentAuthor, "add")).toEqual({ error: PATH_RULE });
  }
  expect(await writeMemory(db, ownerId, where, { ...entry("x.md"), description: "two\nlines" }, agentAuthor, "add")).toEqual({ error: "The description is one line." });
  for (let i = 0; i < MAX_MEMORY_ENTRIES; i++) await writeMemory(db, ownerId, where, entry(`e${i}.md`), agentAuthor, "add");
  const cap = `This memory holds ${MAX_MEMORY_ENTRIES} entries already: remove one first.`;
  await expect(call(router.memories.write, { where, entry: entry("one-more.md") }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST", message: cap });
  expect(await writeMemory(db, ownerId, where, entry("one-more.md"), agentAuthor, "add")).toEqual({ error: cap });
  // Updating one that is there still works, and a removed one doesn't count.
  expect(await writeMemory(db, ownerId, where, entry("e0.md", "New"), agentAuthor, "update")).toHaveProperty("id");
  expect(await removeMemory(db, ownerId, where, "e0.md", agentAuthor)).toBe(true);
  expect(await writeMemory(db, ownerId, where, entry("one-more.md"), agentAuthor, "add")).toHaveProperty("id");
  // Restoring would make 101.
  const [removed] = await db.select().from(memories).where(eq(memories.path, "e0.md"));
  expect(await restoreMemory(db, ownerId, removed!.id)).toEqual({ error: cap });
});

test("add refuses a live path, update a missing one; a table's or an agent's memory goes with it; another owner's scope is not found", async () => {
  const { context, db, ownerId, agent, table, agentAuthor } = await setup();
  const t = { scope: "table" as const, tableId: table.id };
  const a = { scope: "agent" as const, agentId: agent.id };
  await writeMemory(db, ownerId, t, entry("x.md"), agentAuthor, "add");
  expect(await writeMemory(db, ownerId, t, entry("x.md"), agentAuthor, "add")).toEqual({ error: "An entry x.md exists already." });
  expect(await writeMemory(db, ownerId, t, entry("y.md"), agentAuthor, "update")).toEqual({ error: "There is no entry y.md." });
  expect(await writeMemory(db, ownerId, { scope: "table", tableId: "tbl_other" }, entry("x.md"), agentAuthor, "add")).toEqual({ error: "Not found" });
  await expect(call(router.memories.list, { scope: "agent", agentId: "agt_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await writeMemory(db, ownerId, a, entry("x.md"), agentAuthor, "add");
  await call(router.tables.delete, { id: table.id }, { context });
  await call(router.agents.delete, { id: agent.id }, { context });
  expect(await db.select().from(memories)).toEqual([]);
  expect(await db.select().from(memoryRevisions)).toEqual([]);
});

test("accept, an agent's next write clearing it, a person's write making the person the author", async () => {
  const { db, ownerId, agentAuthor } = await setup();
  const where = { scope: "workspace" as const };
  const added = await writeMemory(db, ownerId, where, entry("x.md"), agentAuthor, "add");
  const id = (added as { id: string }).id;
  expect(await acceptMemory(db, ownerId, id)).toEqual({ id });
  expect((await listMemory(db, ownerId, where))[0]!.acceptedAt).toBeInstanceOf(Date);
  await writeMemory(db, ownerId, where, entry("x.md", "Changed"), agentAuthor, "update");
  expect((await listMemory(db, ownerId, where))[0]!.acceptedAt).toBeNull();
  await writeMemory(db, ownerId, where, entry("x.md", "Mine"), { type: "user" }, "upsert");
  const [row] = await listMemory(db, ownerId, where);
  expect([row!.author, row!.acceptedAt]).toEqual([{ type: "user" }, null]);
  expect(await acceptMemory(db, ownerId, id)).toEqual({ error: "Only an agent's entry, not removed, can be accepted." });
});

test("revert brings back the previous revision with its author, and of a first revision removes the entry", async () => {
  const { db, ownerId, agentAuthor } = await setup();
  const where = { scope: "workspace" as const };
  const { id } = (await writeMemory(db, ownerId, where, entry("x.md", "Agent's"), agentAuthor, "add")) as { id: string };
  await acceptMemory(db, ownerId, id);
  await writeMemory(db, ownerId, where, entry("x.md", "Person's"), { type: "user" }, "upsert");
  await revertMemory(db, ownerId, id);
  const [row] = await listMemory(db, ownerId, where);
  // Not an acceptance: the agent's revision waits for one again.
  expect([row!.body, row!.author, row!.acceptedAt, row!.revision]).toEqual(["Agent's", agentAuthor, null, 3]);

  const { id: first } = (await writeMemory(db, ownerId, where, entry("y.md", "Only"), agentAuthor, "add")) as { id: string };
  await revertMemory(db, ownerId, first);
  expect((await listMemory(db, ownerId, where)).map((e) => e.path)).toEqual(["x.md"]);
  await restoreMemory(db, ownerId, first);
  expect((await listMemory(db, ownerId, where)).map((e) => [e.path, e.body])).toEqual([
    ["x.md", "Agent's"],
    ["y.md", "Only"],
  ]);
});

test("an entry an agent removed is skipped and restored by the owner with its last body; a later add at its path brings it back", async () => {
  const { context, db, ownerId, agentAuthor } = await setup();
  const where = { scope: "workspace" as const };
  const { id } = (await writeMemory(db, ownerId, where, entry("x.md", "Last"), agentAuthor, "add")) as { id: string };
  expect(await removeMemory(db, ownerId, where, "x.md", agentAuthor)).toBe(true);
  expect(await removeMemory(db, ownerId, where, "x.md", agentAuthor)).toBe(false);
  expect(await listMemory(db, ownerId, where)).toEqual([]);
  const listed = await call(router.memories.list, where, { context });
  expect(listed.removed.map((e) => [e.path, e.author.type])).toEqual([["x.md", "agent"]]);
  await call(router.memories.restore, { id }, { context });
  expect((await listMemory(db, ownerId, where)).map((e) => [e.body, e.author])).toEqual([["Last", agentAuthor]]);
  await removeMemory(db, ownerId, where, "x.md", agentAuthor);
  expect(await writeMemory(db, ownerId, where, entry("x.md", "Again"), agentAuthor, "add")).toEqual({ id });
  await expect(call(router.memories.restore, { id }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("two adds of one path at once: one lands; two updates: both revisions kept", async () => {
  const { db, ownerId, agentAuthor } = await setup();
  const where = { scope: "workspace" as const };
  const adds = await Promise.all([writeMemory(db, ownerId, where, entry("x.md", "A"), agentAuthor, "add"), writeMemory(db, ownerId, where, entry("x.md", "B"), agentAuthor, "add")]);
  expect(adds.filter((r) => "error" in r)).toEqual([{ error: "An entry x.md exists already." }]);
  await Promise.all([writeMemory(db, ownerId, where, entry("x.md", "C"), agentAuthor, "update"), writeMemory(db, ownerId, where, entry("x.md", "D"), agentAuthor, "update")]);
  const [row] = await listMemory(db, ownerId, where);
  const revisions = await db.select().from(memoryRevisions).where(eq(memoryRevisions.memoryId, row!.id));
  expect(revisions.map((r) => r.revision).sort()).toEqual([1, 2, 3]);
  expect(row!.body).toBe(revisions.find((r) => r.revision === 3)!.body);
});

test("the index groups by type, by path in each group", () => {
  const e = (path: string, type: "business" | "practice" | "fact" | "reference") => ({ path, name: path, description: "d", type });
  expect(memoryIndex([e("z.md", "fact"), e("b.md", "reference"), e("a.md", "fact"), e("p.md", "practice")])).toBe(
    "How work is done:\n- [p.md](p.md): d\n\nFacts:\n- [a.md](a.md): d\n- [z.md](z.md): d\n\nWhere things are:\n- [b.md](b.md): d",
  );
  expect(memoryIndex([])).toBe("");
});

test("a write's span and metric carry its scope, operation and result, never its content", async () => {
  const { context } = await setup();
  const t = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  const where = { scope: "workspace" as const };
  const secret = { path: "sentinel-path.md", name: "sentinel-name", description: "sentinel-description", type: "fact", body: "sentinel-body" };
  await call(router.memories.write, { where, entry: secret }, { context });
  await expect(call(router.memories.write, { where, entry: { ...secret, path: "sentinel-bad.txt" } }, { context })).rejects.toThrow();
  const span = t.spans().find((s) => s.name === "memory.write")!;
  expect(span.attributes).toMatchObject({ "dispand.memory.scope": "workspace", "dispand.memory.op": "add", "dispand.result": "ok" });
  const points = await t.metrics();
  expect(points).toContainEqual({ name: "dispand.memory.writes", attributes: { "dispand.memory.scope": "workspace", "dispand.memory.op": "add", "dispand.result": "ok" } });
  expect(points).toContainEqual({ name: "dispand.memory.writes", attributes: { "dispand.memory.scope": "workspace", "dispand.memory.op": "add", "dispand.result": "refused" } });
  expect(await t.all()).not.toContain("sentinel");
});
