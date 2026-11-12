import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { audit, events, memories, user, workspaceSettings } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { SWEEP_BATCH, sweepAudit } from "./sweep.ts";

const DAY = 24 * 60 * 60_000;
const now = new Date("2026-06-01T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

const row = (ownerId: string, id: string, at: Date) => ({
  id,
  ownerId,
  at,
  actor: { type: "scheduler" as const },
  action: "job.skipped" as const,
  resourceType: "trigger" as const,
  resourceId: "trg_1",
  result: "ok" as const,
  details: {},
});

test("each owner's rows past its own retention go, 90 days without a settings row; events and memory stay", async () => {
  const context = await ownerContext();
  const { db, ownerId } = context;
  await db.insert(user).values({ id: "user_other", name: "Bob", email: "bob@example.com" });
  await call(router.workspace.setAuditRetention, { days: 7 }, { context });
  for (const [owner, prefix] of [
    [ownerId, "a"],
    ["user_other", "b"],
  ] as const) {
    await db.insert(audit).values([row(owner, `${prefix}_1`, daysAgo(1)), row(owner, `${prefix}_8`, daysAgo(8)), row(owner, `${prefix}_91`, daysAgo(91))]);
  }
  const old = daysAgo(400);
  await db.insert(events).values({ id: "evt_1", ownerId, tableId: "tbl_1", rowId: "row_1", operation: "created", changedFieldIds: [], before: {}, after: {}, actor: { type: "user", userId: ownerId }, createdAt: old });
  await db.insert(memories).values({ id: "mem_1", ownerId, scope: "workspace", path: "notes.md", name: "Notes", description: "", type: "reference", body: "", author: { type: "user" }, revision: 1, updatedAt: old });

  expect(await sweepAudit(db, now)).toEqual({ removed: 3 });
  expect((await db.select({ id: audit.id }).from(audit)).map((r) => r.id).sort()).toEqual(["a_1", "b_1", "b_8"]);
  expect(await db.select({ id: events.id }).from(events)).toEqual([{ id: "evt_1" }]);
  expect(await db.select({ id: memories.id }).from(memories)).toEqual([{ id: "mem_1" }]);
  // Nothing more to do, and a row just past the retention goes on the next sweep.
  expect(await sweepAudit(db, now)).toEqual({ removed: 0 });
  expect(await sweepAudit(db, new Date(now.getTime() + 7 * DAY))).toEqual({ removed: 1 });
});

test("a sweep deletes in batches until none is left past the retention", async () => {
  const { db, ownerId } = await ownerContext();
  await db.insert(workspaceSettings).values({ ownerId, auditRetentionDays: 1 });
  const past = SWEEP_BATCH * 2 + 5;
  await db.insert(audit).values(Array.from({ length: past }, (_, i) => row(ownerId, `old_${i}`, daysAgo(2 + i / 10_000))));
  await db.insert(audit).values(row(ownerId, "new", daysAgo(0.5)));
  expect(await sweepAudit(db, now)).toEqual({ removed: past });
  expect(await db.select({ id: audit.id }).from(audit).where(eq(audit.ownerId, ownerId))).toEqual([{ id: "new" }]);
});
