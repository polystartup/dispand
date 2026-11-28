import { readdirSync, readFileSync } from "node:fs";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { expect, onTestFinished, test } from "vitest";
import { testDb } from "../runners/test-support.ts";
import { closeDb, migrateDb, openDb } from "./client.ts";
import * as schema from "./schema.ts";
import { migrateTo } from "./upgrade-fixture.ts";

// A text column with a set of values takes them from one list (`text(name, { enum })`), which
// types it and builds its check (`oneOf` in schema.ts), so the two can't drift apart.

test("a text column is typed by its list of values, never by a bare `$type`", () => {
  const source = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  expect(source.match(/text\("[a-z_]+"\)\.\$type</g) ?? []).toEqual([]);
});

test("the database's checks allow every value of every column's list, and refuse others", async () => {
  const db = await testDb();
  const { rows } = (await db.execute(
    sql`select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def from pg_constraint where contype = 'c'`,
  )) as unknown as { rows: { tbl: string; def: string }[] };
  const checked: string[] = [];
  const missing: string[] = [];
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const { name, columns } = getTableConfig(table);
    for (const column of columns) {
      if (!column.enumValues) continue;
      checked.push(`${name}.${column.name}`);
      const defs = rows.filter((r) => r.tbl.replaceAll('"', "") === name && new RegExp(`\\b${column.name}\\b`).test(r.def));
      const allowed = new Set(defs.flatMap((r) => [...r.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1])));
      missing.push(...column.enumValues.filter((v) => !allowed.has(v)).map((v) => `${name}.${column.name}: ${v}`));
    }
  }
  expect(checked).toEqual(expect.arrayContaining(["runs.status", "step_runs.queue_class", "audit.action", "widgets.type"]));
  expect(missing).toEqual([]);
  // A value outside the list is refused.
  await expect(db.execute(sql`insert into organizations (id) values ('o1')`)).resolves.toBeDefined();
  await expect(db.execute(sql`insert into workspaces (id, organization_id) values ('w1', 'o1')`)).resolves.toBeDefined();
  await expect(db.execute(sql`insert into runs (id, workspace_id, version, status) values ('r1', 'w1', 1, 'paused')`)).rejects.toThrow();
});

test("0137 adds its checks without reading the rows already there, and checks every write after", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await migrateTo(db, "0136_message_parts");
  await db.execute(sql`insert into organizations (id) values ('o1')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values ('w1', 'o1')`);
  // A row no release wrote: the install still boots.
  await db.execute(sql`insert into runs (id, workspace_id, version, status) values ('r_odd', 'w1', 1, 'paused')`);

  await migrateDb(db);

  const run = (id: string, status: string) => sql`insert into runs (id, workspace_id, version, status) values (${id}, 'w1', 1, ${status})`;
  await expect(db.execute(run("r_new", "paused"))).rejects.toThrow();
  await db.execute(run("r1", "running"));
  const step = (id: string, set: string) =>
    db.execute(
      sql.raw(`insert into step_runs (id, run_id, node_id, status, working, queued_at, queue_class) values ('${id}', 'r1', '${id}', 'running', ${set})`),
    );
  await step("s_working", "true, null, null");
  await step("s_queued", "false, now(), 'person'");
  // Holding a slot and waiting for one; queued without a class; a class without a queue.
  await expect(step("s_both", "true, now(), 'person'")).rejects.toThrow();
  await expect(step("s_classless", "false, now(), null")).rejects.toThrow();
  await expect(step("s_stray", "false, null, 'new'")).rejects.toThrow();
  await expect(db.execute(sql`update step_runs set working = true where id = 's_queued'`)).rejects.toThrow();
});

test("until #658 validates them, a later migration adds a check NOT VALID: a re-added one would scan rows 0137 left unread", () => {
  const folder = new URL("../../drizzle/", import.meta.url);
  const statements = readdirSync(folder)
    .filter((f) => f.endsWith(".sql") && f > "0138")
    .flatMap((f) => readFileSync(new URL(f, folder), "utf8").split("--> statement-breakpoint"));
  expect(statements.filter((s) => /ADD CONSTRAINT "[^"]+" CHECK/.test(s) && !/NOT VALID/.test(s))).toEqual([]);
});
