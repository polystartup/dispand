import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { agentSkills, attachments, fields, plugins, rows, skillPackages, tables, tools, workspaces } from "./schema.ts";
import { ownTables } from "../agents/procedures.ts";
import { recordCreated } from "../platform/proposals.ts";
import { requireTools } from "../skills/procedures.ts";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import { takeChatFiles } from "../data/files.ts";
import { writeRow } from "../data/rows.ts";
import { router } from "../rpc/router.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { assertSameWorkspace } from "./same-workspace.ts";

// Ids kept in jsonb or text columns have no foreign key: each is checked against the workspace of
// the row it is written on (`agents.data_tables`, `triggers.config`, `chat_queue.skill_id`,
// `messages.files`, `chat_queue.files`, `rows.values`, `skill_packages.required_tool_ids`,
// `plugins.created`).

async function setup() {
  const context = await ownerContext();
  // Made first: owner procedures need the install's one workspace.
  const job = await jobIdentity(context);
  const local = await call(router.tables.create, { name: "Here" }, { context });
  const reference = await call(router.fields.create, { tableId: local.id, name: "Link", type: "reference", referencesTableId: local.id }, { context });
  await context.db.insert(workspaces).values({ id: "ws-b", organizationId: context.organizationId });
  await context.db.insert(tables).values({ id: "tbl_b", ownerId: context.ownerId, workspaceId: "ws-b", name: "Elsewhere" });
  await context.db.insert(tools).values({ id: "tool_b", ownerId: context.ownerId, workspaceId: "ws-b", name: "Elsewhere", kind: "http", url: "https://example.com/mcp", transport: "streamable-http" });
  await context.db.insert(attachments).values({ id: "att_b", ownerId: context.ownerId, workspaceId: "ws-b", name: "b.txt", mime: "text/plain", size: 1, image: false });
  return { ...context, job, local, reference };
}

test("an id of the workspace passes, and of another workspace is refused, for each kind of row ids name", async () => {
  const { db, workspaceId } = await setup();
  await expect(assertSameWorkspace(db, "ws-b", [{ table: tables, ids: ["tbl_b"] }, { table: tools, ids: ["tool_b"] }, { table: attachments, ids: ["att_b"] }])).resolves.toBeUndefined();
  await expect(assertSameWorkspace(db, workspaceId, [{ table: tables, ids: ["tbl_b"] }])).rejects.toMatchObject({ code: "NOT_FOUND", data: { key: "data.table.notFound" } });
  await expect(assertSameWorkspace(db, workspaceId, [{ table: tools, ids: ["tool_b"] }])).rejects.toMatchObject({ code: "NOT_FOUND", data: { key: "tools.notFound" } });
  await expect(assertSameWorkspace(db, workspaceId, [{ table: attachments, ids: ["att_b"] }])).rejects.toMatchObject({ code: "NOT_FOUND", data: { key: "data.file.gone" } });
  await expect(assertSameWorkspace(db, workspaceId, [{ table: tables, ids: [] }])).resolves.toBeUndefined();
});

test("messages.files and chat_queue.files: a held file of another workspace isn't given to a Job", async () => {
  const { db, ownerId, job } = await setup();
  await expect(db.transaction((tx) => takeChatFiles(tx, ownerId, job.runId, ["att_b"]))).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.gone" } });
});

test("rows.values: a reference to a row of another workspace's table is refused", async () => {
  const { db, ownerId, workspaceId, local, reference } = await setup();
  // Inconsistent on purpose: a database whose keys don't carry the workspace lets a field name another
  // workspace's table, and only writeRow's workspace check refuses its rows then.
  await db.insert(rows).values({ id: "row_b", ownerId, tableId: "tbl_b", values: {} });
  await db.update(fields).set({ referencesTableId: "tbl_b" }).where(eq(fields.id, reference.id));
  const written = await db.transaction((tx) => writeRow(tx, { ownerId, workspaceId, tableId: local.id, values: { [reference.id]: "row_b" }, actor: { type: "user", userId: ownerId } }));
  expect(written).toMatchObject({ problem: { key: "data.row.noRow" } });
});

test("agents' skill packages: a package of another workspace listed on an agent gives it nothing", async () => {
  const { db, ownerId, job } = await setup();
  // Inconsistent on purpose: a database whose keys don't carry the workspace lets an agent list another
  // workspace's package, and only skillsAndTools' workspace check leaves it out then.
  await db.insert(skillPackages).values({ id: "pkg_b", ownerId, workspaceId: "ws-b", name: "elsewhere", description: "Elsewhere", requiredToolIds: ["tool_b"] });
  await db.insert(agentSkills).values({ agentId: job.agentId, packageId: "pkg_b" });
  expect(await skillsAndTools(db, job.agentId)).toMatchObject({ skills: [], tools: [] });
});

test("agents.data_tables: another workspace's table is left out of an agent's list", async () => {
  const { db, workspaceId, local } = await setup();
  expect(await ownTables(db, workspaceId, [local.id, "tbl_b"])).toEqual([local.id]);
});

test("skill_packages.required_tool_ids: another workspace's tool is refused", async () => {
  const { db, workspaceId } = await setup();
  await expect(db.transaction((tx) => requireTools(tx, workspaceId, ["tool_b"]))).rejects.toMatchObject({ code: "NOT_FOUND", data: { key: "tools.notFound" } });
});

test("plugins.created: a plugin never lists an element of another workspace", async () => {
  const { db, ownerId, workspaceId } = await setup();
  await db.insert(plugins).values({ id: "plugin_a", ownerId, workspaceId, name: "Made", description: "", source: "generated", components: { skills: [], mcpServers: [], agents: [] } });
  await expect(recordCreated(db, "plugin_a", "table", "tbl_b")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await db.select({ created: plugins.created }).from(plugins).where(eq(plugins.id, "plugin_a")))[0]!.created).toEqual({});
});

// triggers.config: `checkConfig` refuses another workspace's table (triggers/procedures.test.ts).
// chat_queue.skill_id: `invokedSnapshot` reads the run's workspace (assistant/invoke.test.ts).
