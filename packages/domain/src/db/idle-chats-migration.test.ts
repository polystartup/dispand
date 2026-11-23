import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, migrateDb, openDb } from "./client.ts";
import { stepRuns } from "./schema.ts";
import { migrateTo } from "./upgrade-fixture.ts";

test("existing idle chats retain their activity time on upgrade", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await migrateTo(db, "0107_nullable_run_person");
  await db.execute(sql`insert into organizations (id) values ('org')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values ('space', 'org')`);
  await db.execute(sql`insert into runs (id, workspace_id, version, status) values ('run', 'space', 1, 'running')`);
  await db.execute(sql`insert into step_runs (id, node_id, run_id, status, turn_status, start, started_at, last_activity_at) values
    ('active', 'a', 'run', 'running', 'running', '{"interactive":true}', '2025-01-01', '2025-01-02'),
    ('button', 'b', 'run', 'running', 'idle', '{"interactive":false}', '2025-01-01', '2025-01-02'),
    ('closed', 'c', 'run', 'succeeded', 'idle', '{"interactive":true}', '2025-01-01', '2025-01-02'),
    ('idle', 'd', 'run', 'running', 'idle', '{"interactive":true}', '2025-01-01', '2025-01-02'),
    ('start-only', 'e', 'run', 'running', 'idle', '{"interactive":true}', '2025-01-01', null)`);

  await migrateDb(db);
  expect(await db.select({ id: stepRuns.id, idleSince: stepRuns.idleSince }).from(stepRuns).orderBy(stepRuns.id)).toEqual([
    { id: "active", idleSince: null },
    { id: "button", idleSince: null },
    { id: "closed", idleSince: null },
    { id: "idle", idleSince: new Date("2025-01-02T00:00:00Z") },
    { id: "start-only", idleSince: new Date("2025-01-01T00:00:00Z") },
  ]);
});
