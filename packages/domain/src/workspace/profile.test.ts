import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { inScope, setTenancy, shared, SYSTEM } from "../db/scope.ts";
import { audit, organizations, runs, user, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, recordingDb, recordScopes } from "../runners/test-support.ts";

const rows = (db: Awaited<ReturnType<typeof ownerContext>>["db"]) => db.select().from(audit).where(eq(audit.action, "profile.updated"));

test("profile › saves, reads back, and an empty text clears it", async () => {
  const context = await ownerContext();
  expect(await call(router.profile.get, undefined, { context })).toEqual({ description: null });
  await call(router.profile.update, { description: "  Billing and refunds.  " }, { context });
  expect(await call(router.profile.get, undefined, { context })).toEqual({ description: "Billing and refunds." });
  await call(router.profile.update, { description: " \n " }, { context });
  expect(await call(router.profile.get, undefined, { context })).toEqual({ description: null });
  expect((await context.db.select({ d: user.description }).from(user).where(eq(user.id, context.ownerId)))[0]!.d).toBeNull();
});

test("profile › 1,000 characters are saved and 1,001 is BAD_REQUEST", async () => {
  const context = await ownerContext();
  await call(router.profile.update, { description: "a".repeat(1000) }, { context });
  await expect(call(router.profile.update, { description: "a".repeat(1001) }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await call(router.profile.get, undefined, { context })).description).toHaveLength(1000);
});

test("profile › the audit row carries no text", async () => {
  const context = await ownerContext();
  await call(router.profile.update, { description: "Secret billing knowledge" }, { context });
  const [row] = await rows(context.db);
  expect(row).toMatchObject({ ownerId: context.ownerId, actor: { type: "user", userId: context.ownerId }, resourceType: "user", resourceId: context.ownerId, details: {}, result: "ok" });
  expect(JSON.stringify(row)).not.toContain("Secret");
});

test("profile › each workspace the person can open gets its row, and no other", async () => {
  const context = await ownerContext();
  await context.db.insert(workspaces).values({ id: "ws_b", organizationId: context.organizationId });
  await context.db.insert(organizations).values({ id: "org_other" });
  await context.db.insert(workspaces).values({ id: "ws_other", organizationId: "org_other" });
  await call(router.profile.update, { description: "x" }, { context });
  expect((await rows(context.db)).map((r) => r.workspaceId).sort()).toEqual([context.workspaceId, "ws_b"].sort());
});

test("profile › with a tenancy that splits work, each row is written in its own workspace's scope", async () => {
  const context = await ownerContext();
  await context.db.insert(workspaces).values({ id: "ws_b", organizationId: context.organizationId });
  const recorder = await recordScopes(context.db);
  setTenancy(recorder.db, {
    async each(db, scopes, work) {
      for (const scope of await scopes(db)) await inScope(scope, work);
    },
    forRun: shared.forRun,
  });
  onTestFinished(() => setTenancy(recorder.db, shared));
  await call(router.profile.update, { description: "x" }, { context: { ...context, db: recorder.db, authDb: recorder.db } });
  const inserts = recorder.statements.filter((st) => st.sql.startsWith('insert into "audit"'));
  // The row's workspace is its insert's second parameter, after its id.
  expect(inserts.map((st) => [st.scope !== SYSTEM && st.scope.workspaceId, st.params[1]]).sort()).toEqual([[context.workspaceId, context.workspaceId], ["ws_b", "ws_b"]].sort());
  expect((await rows(context.db)).map((r) => r.workspaceId).sort()).toEqual([context.workspaceId, "ws_b"].sort());
});

test("profile › a Job can't write a person's profile", async () => {
  const context = await ownerContext();
  await context.db.insert(runs).values({ id: "r", workspaceId: context.workspaceId, ownerId: context.ownerId, source: "agent", version: 0, status: "running" });
  await expect(call(router.profile.update, { description: "x" }, { context: { ...context, job: { runId: "r", ownerId: context.ownerId, workspaceId: context.workspaceId, agentId: "a" } } })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("profile › with a separate authDb the description is written there and the audit row in db", async () => {
  const context = await ownerContext();
  const domain = await recordingDb(context.db);
  const identity = await recordingDb(context.db);
  await call(router.profile.update, { description: "Billing" }, { context: { ...context, db: domain.db, authDb: identity.db } });
  expect(identity.statements.filter((s) => /^update "user"/.test(s))).toHaveLength(1);
  expect(domain.statements.filter((s) => /^update "user"/.test(s))).toEqual([]);
  expect(domain.statements.some((s) => s.startsWith('insert into "audit"'))).toBe(true);
  expect(identity.statements.some((s) => s.includes('"audit"'))).toBe(false);
});

test("profile › is the person's own, in an installation of several workspaces too", async () => {
  const context = await ownerContext();
  await context.db.insert(organizations).values({ id: "another-org" });
  await context.db.insert(workspaces).values({ id: "another-workspace", organizationId: "another-org" });
  await call(router.profile.update, { description: "Billing" }, { context });
  expect(await call(router.profile.get, undefined, { context })).toEqual({ description: "Billing" });
});
