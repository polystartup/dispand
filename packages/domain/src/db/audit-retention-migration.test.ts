import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, migrateDb, openDb } from "./client.ts";
import { organizations } from "./schema.ts";
import { migrateTo } from "./upgrade-fixture.ts";

test("each organization keeps the longest Audit retention of its workspaces on upgrade; one without workspaces starts at 730 days", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await migrateTo(db, "0121_person_retention");
  await db.execute(sql`alter table workspaces disable trigger workspaces_limit`);
  await db.execute(sql`insert into organizations (id) values ('org_set'), ('org_unset'), ('org_empty')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values ('a1', 'org_set'), ('a2', 'org_set'), ('a3', 'org_set'), ('b1', 'org_unset')`);
  // a1 keeps 30 days, a2 400, a3 has no settings row (90): the longest is 400.
  await db.execute(sql`insert into workspace_settings (workspace_id, audit_retention_days) values ('a1', 30), ('a2', 400)`);
  await migrateDb(db);
  expect(await db.select({ id: organizations.id, days: organizations.auditRetentionDays }).from(organizations).orderBy(organizations.id))
    .toEqual([{ id: "org_empty", days: 730 }, { id: "org_set", days: 400 }, { id: "org_unset", days: 90 }]);
});
