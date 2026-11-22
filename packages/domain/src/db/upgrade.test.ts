import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, migrateDb, openDb } from "./client.ts";
import { migrateTo, PRE_UPGRADE_TAG, SEEDED_TABLES, seedPreUpgrade } from "./upgrade-fixture.ts";

async function freshDb() {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  const filesDir = await mkdtemp(join(tmpdir(), "dispand-upgrade-"));
  onTestFinished(() => rm(filesDir, { recursive: true, force: true }));
  return { db, filesDir };
}

/** Every seeded table's rows, each as JSON, sorted: what an upgrade must keep. */
async function snapshot(db: Awaited<ReturnType<typeof openDb>>) {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of SEEDED_TABLES) {
    const result = await db.execute(sql.raw(`select to_jsonb(t) as r from "${table}" t order by t`));
    out[table] = (result as unknown as { rows: { r: Record<string, unknown> }[] }).rows.map((row) => row.r);
  }
  return out;
}

test("the pre-upgrade fixture migrates cleanly to the latest schema", async () => {
  const { db, filesDir } = await freshDb();
  await migrateTo(db, PRE_UPGRADE_TAG);
  const seeded = await seedPreUpgrade(db, filesDir);
  const before = await snapshot(db);
  expect(Object.entries(before).filter(([, rows]) => rows.length === 0).map(([table]) => table), "seeded tables left empty").toEqual([]);

  await migrateDb(db);

  // A column a later migration adds doesn't fail this; a lost row or a changed value does.
  const after = await snapshot(db);
  const kept = Object.fromEntries(Object.entries(after).map(([table, rows]) => [table, rows.map((row) =>
    Object.fromEntries(Object.keys(before[table]![0]!).map((column) => [column, row[column]])))]));
  expect(kept).toEqual(before);
  for (const id of seeded.attachmentIds) {
    const result = await db.execute(sql`select owner_id from attachments where id = ${id}`);
    const { owner_id } = (result as unknown as { rows: { owner_id: string }[] }).rows[0]!;
    await access(join(filesDir, owner_id, id));
  }
});

test("migrateTo stops at the named migration", async () => {
  const { db } = await freshDb();
  await migrateTo(db, "0000_init");
  const result = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  expect((result as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(1);
  await expect(migrateTo(db, "no-such-tag")).rejects.toThrow("no-such-tag");
});

test("workspace settings go to the only workspace, one row kept; none with several workspaces", async () => {
  for (const [workspaces, kept] of [[1, 1], [2, 0]] as const) {
    const { db } = await freshDb();
    await migrateTo(db, "0096_user_description");
    await db.execute(sql`insert into organizations (id) values ('org')`);
    for (let i = 0; i < workspaces; i++) await db.execute(sql`insert into workspaces (id, organization_id) values (${`ws_${i}`}, 'org')`);
    await db.execute(sql`insert into "user" (id, name, email) values ('u_a', 'A', 'a@example.com'), ('u_b', 'B', 'b@example.com')`);
    await db.execute(sql`insert into workspace_settings (owner_id, checkpoint) values ('u_a', 5), ('u_b', 7)`);
    await migrateDb(db);
    const result = await db.execute(sql`select workspace_id from workspace_settings`);
    expect((result as unknown as { rows: { workspace_id: string }[] }).rows).toEqual(kept ? [{ workspace_id: "ws_0" }] : []);
  }
});
