import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, createDb } from "./client.ts";
import { newId } from "../ids.ts";

// Both drivers return their rows under `rows`; the neutral Db type doesn't say so.
const rowsOf = (result: unknown) => (result as { rows: unknown[] }).rows;

test("createDb on pglite://memory runs queries and applies migrations", async () => {
  const db = await createDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  const one = await db.execute(sql`select 1 as one`);
  expect(rowsOf(one)[0]).toEqual({ one: 1 });
  const table = await db.execute(
    sql`select table_name from information_schema.tables where table_name = '__drizzle_migrations'`,
  );
  expect(rowsOf(table)).toHaveLength(1);
});

test("newId prefixes a ulid", () => {
  expect(newId("proj")).toMatch(/^proj_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("0025 keeps existing runs as workflow runs", async () => {
  const db = await createDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await db.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await db.execute(
    sql`insert into workflows (id, owner_id, name, current_version) values ('wf_1', 'user_1', 'Old', 1)`,
  );
  // A run as it was written before the migration: no source, no definition.
  await db.execute(
    sql`insert into runs (id, owner_id, workflow_id, version, status) values ('run_1', 'user_1', 'wf_1', 1, 'succeeded')`,
  );
  const run = await db.execute(sql`select source, def, agent_id, trigger_id, cause, snapshot from runs`);
  expect(rowsOf(run)[0]).toEqual({
    source: "workflow",
    def: null,
    agent_id: null,
    trigger_id: null,
    cause: null,
    snapshot: null,
  });
});
