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

async function counts(db: Awaited<ReturnType<typeof openDb>>) {
  const out: Record<string, number> = {};
  for (const table of SEEDED_TABLES) {
    const result = await db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
    out[table] = (result as unknown as { rows: { n: number }[] }).rows[0]!.n;
  }
  return out;
}

test("the pre-upgrade fixture migrates cleanly to the latest schema", async () => {
  const { db, filesDir } = await freshDb();
  await migrateTo(db, PRE_UPGRADE_TAG);
  const seeded = await seedPreUpgrade(db, filesDir);
  const before = await counts(db);
  expect(Object.values(before).every((n) => n > 0), JSON.stringify(before)).toBe(true);

  await migrateDb(db);

  expect(await counts(db)).toEqual(before);
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
