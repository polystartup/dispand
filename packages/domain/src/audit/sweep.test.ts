import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { inScope, setTenancy, shared, SYSTEM } from "../db/scope.ts";
import { audit, events, memories, organizations, user, workspaces } from "../db/schema.ts";
import { ORGANIZATION_HEADER } from "../workspace/authorize.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, recordScopes } from "../runners/test-support.ts";
import { auditSweepScopes, SWEEP_BATCH, sweepAudit } from "./sweep.ts";

const DAY = 24 * 60 * 60_000;
const now = new Date("2026-06-01T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

const row = (ownerId: string, id: string, at: Date, workspaceId: string) => ({
  id,
  workspaceId,
  ownerId,
  at,
  actor: { type: "scheduler" as const },
  action: "job.skipped" as const,
  resourceType: "trigger" as const,
  resourceId: "trg_1",
  result: "ok" as const,
  details: {},
});

test("every member's rows past the organization's retention go; events and memory stay", async () => {
  const context = await ownerContext();
  const { db, ownerId } = context;
  await db.insert(user).values({ id: "user_other", name: "Bob", email: "bob@example.com" });
  await call(router.organization.setRetention, { personDays: 90, auditDays: 7 }, { context: { ...context, headers: new Headers([...context.headers, [ORGANIZATION_HEADER, context.organizationId]]) } });
  for (const [owner, prefix] of [
    [ownerId, "a"],
    ["user_other", "b"],
  ] as const) {
    await db.insert(audit).values([row(owner, `${prefix}_1`, daysAgo(1), context.workspaceId), row(owner, `${prefix}_8`, daysAgo(8), context.workspaceId), row(owner, `${prefix}_91`, daysAgo(91), context.workspaceId)]);
  }
  const old = daysAgo(400);
  await db.insert(events).values({ id: "evt_1", ownerId, workspaceId: context.workspaceId, tableId: "tbl_1", rowId: "row_1", operation: "created", changedFieldIds: [], before: {}, after: {}, actor: { type: "user", userId: ownerId }, createdAt: old });
  await db.insert(memories).values({ id: "mem_1", ownerId, workspaceId: context.workspaceId, scope: "workspace", path: "notes.md", name: "Notes", description: "", type: "reference", body: "", author: { type: "user" }, revision: 1, updatedAt: old });

  expect(await sweepAudit(db, now)).toEqual({ removed: 4 });
  // Setting the retention left its own row, which is recent.
  expect((await db.select({ id: audit.id }).from(audit).where(eq(audit.action, "job.skipped"))).map((r) => r.id).sort()).toEqual(["a_1", "b_1"]);
  expect(await db.select({ id: events.id }).from(events)).toEqual([{ id: "evt_1" }]);
  expect(await db.select({ id: memories.id }).from(memories)).toEqual([{ id: "mem_1" }]);
  // Nothing more to do, and a row just past the retention goes on the next sweep.
  expect(await sweepAudit(db, now)).toEqual({ removed: 0 });
  expect(await sweepAudit(db, new Date(now.getTime() + 7 * DAY))).toEqual({ removed: 2 });
});

test("730 days until set; each organization's workspaces keep rows for its own retention", async () => {
  const { db, ownerId, organizationId, workspaceId } = await ownerContext();
  await db.insert(organizations).values({ id: "org_b" });
  await db.insert(workspaces).values([{ id: "ws_a2", organizationId }, { id: "ws_b", organizationId: "org_b" }]);
  await db.insert(audit).values([row(ownerId, "a_400", daysAgo(400), workspaceId), row(ownerId, "a_731", daysAgo(731), workspaceId), row(ownerId, "b_731", daysAgo(731), "ws_b")]);
  expect(await sweepAudit(db, now)).toEqual({ removed: 2 });
  await db.insert(audit).values([row(ownerId, "a_10", daysAgo(10), workspaceId), row(ownerId, "a2_10", daysAgo(10), "ws_a2"), row(ownerId, "b_10", daysAgo(10), "ws_b"), row(ownerId, "b_50", daysAgo(50), "ws_b")]);
  await db.update(organizations).set({ auditRetentionDays: 7 }).where(eq(organizations.id, organizationId));
  await db.update(organizations).set({ auditRetentionDays: 60 }).where(eq(organizations.id, "org_b"));
  expect(await sweepAudit(db, now)).toEqual({ removed: 3 });
  expect((await db.select({ id: audit.id }).from(audit)).map((r) => r.id).sort()).toEqual(["b_10", "b_50"]);
});

test("sweepScopes lists the workspaces with a row past their retention, never an idle one", async () => {
  const { db, ownerId, organizationId, workspaceId } = await ownerContext();
  await db.insert(workspaces).values({ id: "ws_b", organizationId });
  await db.insert(audit).values([row(ownerId, "a_1", daysAgo(1), workspaceId), row(ownerId, "b_91", daysAgo(731), "ws_b")]);
  const recorder = await recordScopes(db);
  expect(await auditSweepScopes(recorder.db, now)).toEqual([{ organizationId, workspaceId: "ws_b" }]);
  expect(recorder.statements.every((s) => s.scope === SYSTEM)).toBe(true);
});

test("a split pass deletes in the scope of the workspace it runs for", async () => {
  const { db, ownerId, organizationId, workspaceId } = await ownerContext();
  await db.insert(workspaces).values({ id: "ws_b", organizationId });
  await db.insert(audit).values([row(ownerId, "a_91", daysAgo(731), workspaceId), row(ownerId, "b_91", daysAgo(731), "ws_b")]);
  const recorder = await recordScopes(db);
  const a = { organizationId, workspaceId };
  setTenancy(recorder.db, { each: (_db, _scopes, work) => inScope(a, work), forRun: shared.forRun });
  onTestFinished(() => setTenancy(recorder.db, shared));
  await inScope(SYSTEM, () => sweepAudit(recorder.db, now));
  expect(recorder.statements.some((s) => s.scope !== SYSTEM && s.scope.workspaceId === workspaceId && /delete from "audit"/.test(s.sql))).toBe(true);
});

test("a sweep deletes in batches until none is left past the retention", async () => {
  const { db, ownerId, workspaceId } = await ownerContext();
  await db.update(organizations).set({ auditRetentionDays: 1 });
  const past = SWEEP_BATCH * 2 + 5;
  await db.insert(audit).values(Array.from({ length: past }, (_, i) => row(ownerId, `old_${i}`, daysAgo(2 + i / 10_000), workspaceId)));
  await db.insert(audit).values(row(ownerId, "new", daysAgo(0.5), workspaceId));
  expect(await sweepAudit(db, now)).toEqual({ removed: past });
  expect(await db.select({ id: audit.id }).from(audit).where(eq(audit.ownerId, ownerId))).toEqual([{ id: "new" }]);
});
