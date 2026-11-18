import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { stepView } from "../engine/views.ts";
import { closeDb, createDb } from "./client.ts";
import { stepRuns } from "./schema.ts";

test("turn status migrates as unknown and survives restart independently of Job and slot status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispand-turn-status-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const before = join(dir, "migrations");
  await cp(new URL("../../drizzle", import.meta.url).pathname, before, { recursive: true });
  const journalPath = join(before, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0086");
  await writeFile(journalPath, JSON.stringify(journal));
  const url = `pglite://${join(dir, "db")}`;
  const old = await createDb(url, before);
  await old.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await old.execute(sql`insert into workflows (id, owner_id, name, current_version) values ('wf_1', 'user_1', 'Chat', 1)`);
  await old.execute(sql`insert into runs (id, owner_id, workflow_id, version, status) values ('run_1', 'user_1', 'wf_1', 1, 'running')`);
  await old.execute(sql`insert into step_runs (id, owner_id, run_id, node_id, status, working) values
    ('step_free', 'user_1', 'run_1', 'free', 'running', false),
    ('step_slot', 'user_1', 'run_1', 'slot', 'running', true)`);
  await closeDb(old);

  const db = await createDb(url);
  const migrated = await db.select().from(stepRuns).orderBy(stepRuns.id);
  expect(migrated.map((step) => ({ id: step.id, status: step.status, working: step.working, turnStatus: step.turnStatus }))).toEqual([
    { id: "step_free", status: "running", working: false, turnStatus: "unknown" },
    { id: "step_slot", status: "running", working: true, turnStatus: "unknown" },
  ]);
  await db.update(stepRuns).set({ turnStatus: "running", status: "waiting" }).where(eq(stepRuns.id, "step_free"));
  await db.update(stepRuns).set({ turnStatus: "idle" }).where(eq(stepRuns.id, "step_slot"));
  await closeDb(db);

  const reopened = await createDb(url);
  onTestFinished(() => closeDb(reopened));
  const persisted = await reopened.select().from(stepRuns).orderBy(stepRuns.id);
  expect(persisted.map(stepView)).toMatchObject([
    { id: "step_free", status: "waiting", turnStatus: "running" },
    { id: "step_slot", status: "running", turnStatus: "idle" },
  ]);
  expect(stepView(persisted[0]!)).not.toHaveProperty("working");
});
