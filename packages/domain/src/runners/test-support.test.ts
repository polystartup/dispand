import { eq, sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { workspaces } from "../db/schema.ts";
import { onPostgres } from "./test-tags.ts";
import { ownerContext, stopsBeforeEmptied, testDb } from "./test-support.ts";

// A test may ask for a second context: emptying the database under the first one's engine would
// deadlock with its statements on PostgreSQL (#586), so what it runs stops first, once.
test("a later context of the test stops what an earlier one runs before it empties the database", async () => {
  const first = await ownerContext();
  const engine = vi.spyOn(first.engine, "stop");
  const hub = vi.spyOn(first.hub, "close");
  let release!: () => void;
  const own = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
  stopsBeforeEmptied(own);
  const second = ownerContext();
  await vi.waitFor(() => expect(own).toHaveBeenCalledTimes(1));
  expect(hub).toHaveBeenCalledTimes(1);
  expect(engine).toHaveBeenCalledTimes(1);
  // Not emptied while something still stops: the first context's workspace is there until then.
  expect(await first.db.select().from(workspaces).where(eq(workspaces.id, first.workspaceId))).toHaveLength(1);
  release();
  await second;
  expect(await first.db.select().from(workspaces).where(eq(workspaces.id, first.workspaceId))).toEqual([]);
  // Stopped already: the next emptying, and the test's end, don't stop it again.
  await testDb();
  expect([hub, engine, own].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1]);
});

// What #592 doesn't stop (a statement an earlier test or context left under way) may hold one table
// while it asks for another: emptying the database must not take some tables and wait for the rest.
test.skipIf(!onPostgres)("emptying the database never deadlocks with a statement that holds one table and asks for another", async () => {
  const db = await testDb();
  const { rows } = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`)) as unknown as {
    rows: { tablename: string }[];
  };
  const [first, last] = [rows[0]!.tablename, rows.at(-1)!.tablename];
  let emptied: Promise<unknown> | undefined;
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`lock table "${last}" in access share mode`));
    emptied = testDb();
    // The emptying is under way and waits: for a lock, or before it tries again.
    await vi.waitFor(async () => {
      const waiting = (await db.execute(
        sql`select 1 from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and query like '%truncate%' and wait_event_type in ('Lock', 'Timeout')`,
      )) as unknown as { rows: unknown[] };
      expect(waiting.rows).toHaveLength(1);
    });
    await tx.execute(sql.raw(`lock table "${first}" in access share mode`));
  });
  await expect(emptied).resolves.toBe(db);
});
