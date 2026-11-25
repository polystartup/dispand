import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { testDb } from "../runners/test-support.ts";
import { closeDb, migrateDb, openDb } from "./client.ts";
import { user } from "./schema.ts";
import { migrateTo } from "./upgrade-fixture.ts";

// A time column without a zone holds a wall-clock time in whichever zone wrote it: node-postgres
// sends a Date in Node's zone, `now()` writes the session's. With the zone stored, a time reads the
// same whoever wrote it.
test("every time column stores its zone", async () => {
  const db = await testDb();
  const result = await db.execute(sql`select table_name || '.' || column_name as "column" from information_schema.columns
    where table_schema = 'public' and data_type = 'timestamp without time zone' order by 1`);
  expect((result as unknown as { rows: { column: string }[] }).rows.map((row) => row.column)).toEqual([]);
});

test("the upgrade keeps stored times as UTC, whatever the migrating session's zone", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await migrateTo(db, "0132_assistant_per_workspace");
  await db.execute(sql`insert into "user" (id, name, email, created_at) values ('u', 'A', 'a@example.com', '2025-01-02 03:04:05')`);
  await db.execute(sql`set timezone to 'America/Phoenix'`);

  await migrateDb(db);
  expect(await db.select({ createdAt: user.createdAt }).from(user)).toEqual([{ createdAt: new Date("2025-01-02T03:04:05Z") }]);
});
