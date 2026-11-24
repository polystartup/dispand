import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openAttachment } from "../data/files.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, personContext } from "../runners/test-support.ts";
import { attachments, fields, rows, tables, user } from "./schema.ts";

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
const PERSONAL = ["account", "session", "organization_members", "workspace_members", "workspace_invitations", "push_subscriptions", "agent_escalations", "pages", "widgets"];
/**
 * Authored workspace rows that still go with their author: a Job's person is read from them
 * (agents, triggers, workflows, their fires and runs) or their code keys them by owner. Each
 * leaves this list when a Job can run with no person behind it.
 */
const STILL_CASCADING = [
  "agents", "workflows", "triggers", "schedules", "polls", "poll_items", "trigger_fires", "schedule_fires", "event_fires",
  "runs", "step_runs", "messages", "artifacts", "chat_queue", "cloud_sessions", "proposals", "questions", "roots", "events",
  // A CLI harness points at its runner, which goes with the person who registered it.
  "runners", "harnesses", "tools", "plugins", "plugin_conflicts",
];

test("deleting a person reaches only their personal rows, and the authored rows still listed", async () => {
  const { db } = await ownerContext();
  const result = await db.execute(sql`select c.conrelid::regclass::text as child from pg_constraint c
    where c.contype = 'f' and c.confrelid = '"user"'::regclass and c.confdeltype = 'c'`);
  const cascading = (result as unknown as { rows: { child: string }[] }).rows.map((r) => r.child.replaceAll('"', ""));
  expect([...new Set(cascading)].sort()).toEqual([...PERSONAL, ...STILL_CASCADING].sort());
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
