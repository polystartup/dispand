import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { ownerContext } from "../runners/test-support.ts";
import type { Db } from "./client.ts";

/** The owner's data: removing a plugin may never delete any of it. */
const OWNER_DATA = ["tables", "fields", "rows", "agents", "runs", "messages", "questions", "triggers", "tools", "attachments"];

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
