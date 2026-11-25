import { call } from "@orpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { ensureAssistant } from "../agents/builtin.ts";
import { agents, audit, organizationMembers, organizations, tables, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, personContext } from "../runners/test-support.ts";
import { ORGANIZATION_HEADER } from "./authorize.ts";
import { purgeArchivedPeople } from "./purge.ts";

const day = 24 * 3600_000;

test("the purge deletes people archived longer than their organization's retention, read when it runs, with their Assistant; what they made stays", async () => {
  const owner = await ownerContext();
  const { db, organizationId, workspaceId } = owner;
  const named = { ...owner, headers: new Headers([...owner.headers, [ORGANIZATION_HEADER, organizationId]]) };
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context: owner });
  const pat = await personContext(owner, "pat", "manager");
  await personContext(owner, "sam", "member");
  const { agentId } = await ensureAssistant(db, "pat", harness.id, workspaceId);
  const table = await call(router.tables.create, { name: "Notes" }, { context: pat });
  await call(router.organization.archiveMember, { userId: "pat" }, { context: named });
  await call(router.organization.archiveMember, { userId: "sam" }, { context: named });
  const now = Date.now();
  await db.update(user).set({ archivedAt: new Date(now - 100 * day) }).where(eq(user.id, "pat"));
  await db.update(user).set({ archivedAt: new Date(now - 10 * day) }).where(eq(user.id, "sam"));
  const people = async () => (await db.select({ id: user.id }).from(user).where(inArray(user.id, ["pat", "sam"]))).map((u) => u.id).sort();

  // 90 days by default: Pat (100 days) goes, Sam (10 days) stays.
  expect(await purgeArchivedPeople(owner, new Date(now))).toEqual({ purged: 1 });
  expect(await people()).toEqual(["sam"]);
  expect(await db.select().from(agents).where(eq(agents.id, agentId))).toEqual([]);
  expect(await db.select({ ownerId: tables.ownerId }).from(tables).where(eq(tables.id, table.id))).toEqual([{ ownerId: null }]);
  expect(await db.select({ details: audit.details }).from(audit).where(eq(audit.action, "workspace.personPurged"))).toEqual([{ details: { userId: "pat" } }]);

  // A shorter period, read at the next run: Sam goes too.
  await call(router.organization.setRetention, { personDays: 7, auditDays: 730 }, { context: named });
  expect(await purgeArchivedPeople(owner, new Date(now))).toEqual({ purged: 1 });
  expect(await people()).toEqual([]);
  expect((await db.select().from(user).where(eq(user.id, owner.ownerId))).length).toBe(1);
  expect(await db.select({ days: organizations.personRetentionDays }).from(organizations)).toEqual([{ days: 7 }]);
});

test("only the organization's owner reads and sets its data retention, within 1 to 3650 days", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "manager");
  const header = (c: typeof owner) => ({ ...c, headers: new Headers([...c.headers, [ORGANIZATION_HEADER, owner.organizationId]]) });
  expect(await call(router.organization.retention, undefined, { context: header(owner) })).toEqual({ personDays: 90, auditDays: 730 });
  await expect(call(router.organization.setRetention, { personDays: 30, auditDays: 730 }, { context: header(pat) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.organization.setRetention, { personDays: 0, auditDays: 730 }, { context: header(owner) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.organization.setRetention, { personDays: 3651, auditDays: 730 }, { context: header(owner) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  for (const auditDays of [0, 3651, 1.5]) await expect(call(router.organization.setRetention, { personDays: 30, auditDays }, { context: header(owner) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  for (const days of [1, 3650]) expect(await call(router.organization.setRetention, { personDays: days, auditDays: days }, { context: header(owner) })).toEqual({ personDays: days, auditDays: days });
  const signedOut = { ...owner, headers: new Headers([[ORGANIZATION_HEADER, owner.organizationId]]) };
  await expect(call(router.organization.retention, undefined, { context: signedOut })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(call(router.organization.setRetention, { personDays: 5, auditDays: 5 }, { context: signedOut })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(await call(router.organization.setRetention, { personDays: 30, auditDays: 730 }, { context: header(owner) })).toEqual({ personDays: 30, auditDays: 730 });
  expect(await owner.db.select({ action: audit.action }).from(audit).where(eq(audit.action, "workspace.retentionChanged"))).toHaveLength(3);
});

test("an archive that raced an acceptance elsewhere: the person can't accept, and the purge keeps anyone still in an organization", async () => {
  const owner = await ownerContext();
  const { db, organizationId } = owner;
  const pat = await personContext(owner, "pat", "manager");
  const named = { ...owner, headers: new Headers([...owner.headers, [ORGANIZATION_HEADER, organizationId]]) };
  const invite = await call(router.workspace.invite, { organizationId, workspaceId: owner.workspaceId, email: "sam@example.com", role: "member" }, { context: owner });
  const sam = await personContext(owner, "sam", "member");
  await call(router.organization.archiveMember, { userId: "pat" }, { context: named });
  // The invitation finds Sam while they are not archived; archived (their session still open, as in a race), nothing.
  expect(await call(router.workspace.invitation, { token: invite.token }, { context: sam })).toMatchObject({ workspaceId: owner.workspaceId });
  await db.update(user).set({ archivedAt: new Date() }).where(eq(user.id, "sam"));
  await expect(call(router.workspace.acceptInvitation, { token: invite.token }, { context: sam })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Still a member (as if an acceptance won the race): never purged.
  await db.update(user).set({ archivedAt: new Date(Date.now() - 200 * day) }).where(inArray(user.id, ["pat", "sam"]));
  expect(await purgeArchivedPeople(owner, new Date())).toEqual({ purged: 1 });
  expect((await db.select({ id: user.id }).from(user).where(inArray(user.id, ["pat", "sam"]))).map((u) => u.id)).toEqual(["sam"]);
  expect(pat.ownerId).toBe("pat");
});

test("dispand_purge_person runs as its owner with a pinned path, and purges no one it isn't meant to", async () => {
  const owner = await ownerContext();
  const { db, organizationId } = owner;
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q) as unknown as { rows: T[] }).rows;
  const purge = async (id: string) => (await rows<{ purged: boolean }>(sql`select dispand_purge_person(${id}) as purged`))[0]!.purged;
  expect(await rows<{ definer: boolean; config: string[] }>(sql`select prosecdef as definer, proconfig as config from pg_proc where proname = 'dispand_purge_person'`))
    .toEqual([{ definer: true, config: ["search_path=pg_catalog, public, pg_temp"] }]);
  // No EXECUTE for PUBLIC: only the owner, and whoever a database adapter grants it to.
  expect(await rows<{ public: boolean }>(sql`select has_function_privilege('public', 'dispand_purge_person(text, text)', 'execute') as public`)).toEqual([{ public: false }]);
  await personContext(owner, "pat", "member");
  const old = new Date(Date.now() - 200 * day);
  // Not archived.
  expect(await purge("pat")).toBe(false);
  // Archived, but still in an organization.
  await db.update(user).set({ archivedAt: old, archivedBy: organizationId }).where(eq(user.id, "pat"));
  expect(await purge("pat")).toBe(false);
  await db.delete(organizationMembers).where(eq(organizationMembers.userId, "pat"));
  // Archived and out of every organization, but within a longer retention.
  await db.update(organizations).set({ personRetentionDays: 365 });
  expect(await purge("pat")).toBe(false);
  expect((await db.select({ id: user.id }).from(user).where(eq(user.id, "pat"))).length).toBe(1);
  // Past it: purged, recorded, and only once.
  await db.update(organizations).set({ personRetentionDays: 90 });
  expect(await purge("pat")).toBe(true);
  expect(await purge("pat")).toBe(false);
  expect(await db.select({ details: audit.details }).from(audit).where(eq(audit.action, "workspace.personPurged"))).toEqual([{ details: { userId: "pat" } }]);
});
