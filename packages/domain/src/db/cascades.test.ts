import { call } from "@orpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openAttachment } from "../data/files.ts";
import { router } from "../rpc/router.ts";
import { jobIdentity, ownerContext, personContext } from "../runners/test-support.ts";
import { agents, attachments, fields, plugins, questions, rows, runs, tables, tools, user } from "./schema.ts";
import { ensureAssistant } from "../agents/builtin.ts";

// The smallest valid PNG header.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
import type { Db } from "./client.ts";

/** The owner's data: removing a plugin may never delete any of it. */
const OWNER_DATA = ["tables", "fields", "rows", "agents", "runs", "messages", "chat_queue", "questions", "triggers", "tools", "attachments"];

/**
 * Fails when deleting a `plugins` row would delete the owner's data: walks every `on delete
 * cascade` foreign key from `plugins`, then from each table it reaches, and lists the chains
 * that end in one of `OWNER_DATA`.
 */
export async function assertNoCascadeToOwnerData(db: Db): Promise<void> {
  const result = await db.execute(sql`
    select child.table_name as child, parent.table_name as parent
    from information_schema.referential_constraints rc
    join information_schema.table_constraints child
      on child.constraint_name = rc.constraint_name and child.constraint_schema = rc.constraint_schema
    join information_schema.table_constraints parent
      on parent.constraint_name = rc.unique_constraint_name and parent.constraint_schema = rc.unique_constraint_schema
    where rc.delete_rule = 'CASCADE' and rc.constraint_schema = 'public'`);
  const edges = (result as unknown as { rows: { child: string; parent: string }[] }).rows;
  expect(edges.length).toBeGreaterThan(0);
  const reached = new Map<string, string[]>([["plugins", ["plugins"]]]);
  const queue = ["plugins"];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const edge of edges.filter((e) => e.parent === parent && !reached.has(e.child))) {
      reached.set(edge.child, [...reached.get(parent)!, edge.child]);
      queue.push(edge.child);
    }
  }
  const chains = OWNER_DATA.flatMap((table) => (reached.has(table) ? [reached.get(table)!.join(" → ")] : []));
  expect(chains, "deleting a plugin would delete the owner's data").toEqual([]);
}

test("deleting a plugin cascades to none of the owner's data", async () => {
  const { db } = await ownerContext();
  await assertNoCascadeToOwnerData(db);
});

/** What deleting a person still deletes: their own identity, memberships, devices and pages. */
const PERSONAL = ["account", "session", "organization_members", "workspace_members", "workspace_invitations", "push_subscriptions", "agent_escalations", "pages", "widgets", "subscription_challenges", "subscription_enrollments"];
test("deleting a person reaches only their personal rows", async () => {
  const { db } = await ownerContext();
  const result = await db.execute(sql`select c.conrelid::regclass::text as child from pg_constraint c
    where c.contype = 'f' and c.confrelid = '"user"'::regclass and c.confdeltype = 'c'`);
  const cascading = (result as unknown as { rows: { child: string }[] }).rows.map((r) => r.child.replaceAll('"', ""));
  expect([...new Set(cascading)].sort()).toEqual([...PERSONAL].sort());
});

test("deleting a user keeps workspace data and nulls its authorship", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "manager");
  const table = await call(router.tables.create, { name: "Projects" }, { context: pat });
  const field = await call(router.fields.create, { tableId: table.id, name: "Logo", type: "attachment" }, { context: pat });
  const file = await call(router.files.upload, { tableId: table.id, file: new File([PNG], "logo.png", { type: "image/png" }) }, { context: pat });
  await call(router.rows.create, { tableId: table.id, values: { [field.id]: [file.id] } }, { context: pat });
  await owner.db.delete(user).where(eq(user.id, "pat"));
  expect(await owner.db.select({ ownerId: tables.ownerId }).from(tables).where(eq(tables.id, table.id))).toEqual([{ ownerId: null }]);
  expect(await owner.db.select({ ownerId: fields.ownerId }).from(fields).where(eq(fields.id, field.id))).toEqual([{ ownerId: null }]);
  expect(await owner.db.select({ ownerId: rows.ownerId }).from(rows).where(eq(rows.tableId, table.id))).toEqual([{ ownerId: null }]);
  // The uploader stays the file's storage key: it still downloads.
  expect(await owner.db.select({ ownerId: attachments.ownerId }).from(attachments).where(eq(attachments.id, file.id))).toEqual([{ ownerId: "pat" }]);
  const opened = await openAttachment(owner.db, owner.filesDir, owner.ownerId, file.id);
  expect(new Uint8Array(await new Response(opened!.body).arrayBuffer())).toEqual(PNG);
});

test("deleting a person keeps the plugin they installed and its tools, even one named like a tool of the workspace", async () => {
  const owner = await ownerContext();
  await personContext(owner, "pat", "manager");
  const components = { skills: [], mcpServers: [], agents: [], commands: [], hooks: [] } as unknown as typeof plugins.$inferInsert.components;
  await owner.db.insert(plugins).values({ id: "pats-plugin", workspaceId: owner.workspaceId, ownerId: "pat", name: "Mail kit", description: "", components });
  await owner.db.insert(tools).values([
    { id: "plugin-mail", workspaceId: owner.workspaceId, ownerId: "pat", pluginId: "pats-plugin", name: "Mail", kind: "http" },
    { id: "own-mail", workspaceId: owner.workspaceId, ownerId: owner.ownerId, name: "Mail", kind: "http" },
  ]);
  await owner.db.delete(user).where(eq(user.id, "pat"));
  expect(await owner.db.select({ ownerId: plugins.ownerId }).from(plugins)).toEqual([{ ownerId: null }]);
  expect(await owner.db.select({ id: tools.id, pluginId: tools.pluginId, ownerId: tools.ownerId }).from(tools).orderBy(tools.id))
    .toEqual([{ id: "own-mail", pluginId: null, ownerId: owner.ownerId }, { id: "plugin-mail", pluginId: "pats-plugin", ownerId: null }]);
});

test("deleting a person deletes their Assistant with its chats; the agents they made and the rows they wrote stay", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "manager");
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context: owner });
  const { agentId: assistantId } = await ensureAssistant(owner.db, "pat", harness.id, owner.workspaceId);
  const writer = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context: pat });
  await owner.db.insert(runs).values({ id: "pats-chat", workspaceId: owner.workspaceId, ownerId: "pat", agentId: assistantId, source: "agent", version: 0, status: "running" });
  const table = await call(router.tables.create, { name: "Notes" }, { context: pat });
  await owner.db.delete(user).where(eq(user.id, "pat"));
  expect(await owner.db.select({ id: agents.id, ownerId: agents.ownerId }).from(agents).where(inArray(agents.id, [assistantId, writer.id]))).toEqual([{ id: writer.id, ownerId: null }]);
  expect(await owner.db.select().from(runs).where(eq(runs.id, "pats-chat"))).toEqual([]);
  expect(await owner.db.select({ ownerId: tables.ownerId }).from(tables).where(eq(tables.id, table.id))).toEqual([{ ownerId: null }]);
});

test("deleting a person keeps the Jobs they started running, with no one's, and the questions addressed to them", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "manager");
  const { runId } = await jobIdentity(pat);
  await owner.db.insert(questions).values({ id: "q_pat", ownerId: "pat", addresseeId: "pat", runId, placement: "notifications", kind: "question", payload: { kind: "choice", questions: [] } as never, status: "pending" });
  await owner.db.delete(user).where(eq(user.id, "pat"));
  expect(await owner.db.select({ ownerId: runs.ownerId, status: runs.status }).from(runs).where(eq(runs.id, runId))).toEqual([{ ownerId: null, status: "running" }]);
  expect(await owner.db.select({ ownerId: questions.ownerId, addresseeId: questions.addresseeId }).from(questions).where(eq(questions.id, "q_pat"))).toEqual([{ ownerId: null, addresseeId: null }]);
  // The sweep sends it on: no person behind the run, its agent's creator gone, so the organization's owner.
  expect(await owner.engine.sweepEscalations(new Date())).toBe(1);
  expect(await owner.db.select({ ownerId: questions.ownerId, addresseeId: questions.addresseeId, status: questions.status }).from(questions).where(eq(questions.id, "q_pat")))
    .toEqual([{ ownerId: owner.ownerId, addresseeId: owner.ownerId, status: "pending" }]);
});

test("a question left with no one to ask (the organization's only owner deleted) waits, and the sweep goes on", async () => {
  const owner = await ownerContext();
  const { runId } = await jobIdentity(owner);
  await owner.db.insert(questions).values({ id: "q_owner", ownerId: owner.ownerId, addresseeId: owner.ownerId, runId, placement: "notifications", kind: "question", payload: { kind: "choice", questions: [] } as never, status: "pending" });
  await owner.db.delete(user).where(eq(user.id, owner.ownerId));
  expect(await owner.engine.sweepEscalations(new Date())).toBe(0);
  expect(await owner.db.select({ addresseeId: questions.addresseeId, status: questions.status }).from(questions).where(eq(questions.id, "q_owner"))).toEqual([{ addresseeId: null, status: "pending" }]);
});
