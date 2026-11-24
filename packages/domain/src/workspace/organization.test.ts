import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { SYSTEM } from "../db/scope.ts";
import { audit, organizationMembers, organizations, session, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { recordScopes } from "../db/test-support.ts";
import { router } from "../rpc/router.ts";
import { jobIdentity, ownerContext, personContext } from "../runners/test-support.ts";
import { authorize, ORGANIZATION_HEADER, WORKSPACE_HEADER } from "./authorize.ts";

const missing = { code: "NOT_FOUND" };

/** The owner's organization with a sibling workspace and Pat (a member of the main one), its calls naming the organization. */
async function organization() {
  const owner = await ownerContext();
  const { db, organizationId, workspaceId } = owner;
  await db.insert(workspaces).values({ id: "sibling", organizationId, name: "Sibling" });
  const pat = await personContext(owner, "pat", "member");
  await db.insert(organizations).values({ id: "foreign-org" });
  await db.insert(workspaces).values({ id: "foreign", organizationId: "foreign-org" });
  const named = (context: typeof owner) => ({ ...context, headers: new Headers([...context.headers, [ORGANIZATION_HEADER, organizationId]]) });
  return { plain: owner, owner: named(owner), pat: named(pat), db, organizationId, workspaceId };
}

const api = router.organization;
const rolesOf = async (db: Awaited<ReturnType<typeof ownerContext>>["db"], userId: string) =>
  (await db.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId))).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));

test("only the organization's owner reaches its directory: not a member, a Job or another organization's call", async () => {
  const { plain, owner, pat, workspaceId } = await organization();
  expect(await call(api.directory, undefined, { context: owner })).toEqual({
    workspaces: [{ workspaceId, name: "Main workspace" }, { workspaceId: "sibling", name: "Sibling" }],
    people: [
      { userId: owner.ownerId, name: "Ada", email: "ada@example.com", role: "owner", workspaces: [] },
      { userId: "pat", name: "pat", email: "pat@example.com", role: "member", workspaces: [{ workspaceId, role: "member" }] },
    ],
  });
  await expect(call(api.directory, undefined, { context: pat })).rejects.toMatchObject(missing);
  await expect(call(api.assign, { userId: "pat", workspaceId, role: "manager" }, { context: pat })).rejects.toMatchObject(missing);
  // Two workspaces: the Job's setup names its own.
  const job = { ...owner, job: await jobIdentity({ ...owner, headers: new Headers([...owner.headers, [WORKSPACE_HEADER, workspaceId]]) }) };
  await expect(call(api.directory, undefined, { context: job })).rejects.toMatchObject(missing);
  const foreign = { ...plain, headers: new Headers([...plain.headers, [ORGANIZATION_HEADER, "foreign-org"]]) };
  await expect(call(api.directory, undefined, { context: foreign })).rejects.toMatchObject(missing);
});

test("a directory assignment gives or changes a role in one of the organization's workspaces, for one of its people", async () => {
  const { owner, db, workspaceId } = await organization();
  // A member of a sibling workspace is assigned here too.
  await call(api.assign, { userId: "pat", workspaceId: "sibling", role: "manager" }, { context: owner });
  await call(api.assign, { userId: "pat", workspaceId, role: "manager" }, { context: owner });
  expect(await rolesOf(db, "pat")).toEqual([{ workspaceId, role: "manager" }, { workspaceId: "sibling", role: "manager" }].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)));
  await db.insert(user).values({ id: "outsider", name: "Outsider", email: "outsider@example.com" });
  await expect(call(api.assign, { userId: "outsider", workspaceId, role: "member" }, { context: owner })).rejects.toMatchObject(missing);
  await expect(call(api.assign, { userId: "pat", workspaceId: "foreign", role: "member" }, { context: owner })).rejects.toMatchObject(missing);
  expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, "outsider"))).toEqual([]);
  expect(await db.select({ workspaceId: audit.workspaceId, resourceId: audit.resourceId, details: audit.details }).from(audit).where(eq(audit.action, "workspace.memberAssigned")))
    .toEqual([{ workspaceId: "sibling", resourceId: "sibling", details: { userId: "pat", role: "manager" } }, { workspaceId, resourceId: workspaceId, details: { userId: "pat", role: "manager" } }]);
});

test("a directory change runs as one organization-scoped transaction, its role read under the person alone", async () => {
  const { owner, db, organizationId, workspaceId } = await organization();
  const recorder = await recordScopes(db);
  const context = { ...owner, db: recorder.db };
  await call(api.directory, undefined, { context });
  await call(api.assign, { userId: "pat", workspaceId: "sibling", role: "member" }, { context });
  await call(api.unassign, { userId: "pat", workspaceId }, { context });
  const outside = recorder.statements.filter((s) => s.scope === SYSTEM || JSON.stringify(s.scope) !== JSON.stringify({ userId: owner.ownerId, organizationId }));
  // Only the middleware's ownership check runs under the person alone.
  expect(outside.map((s) => [s.scope, s.sql.slice(0, 60)])).toEqual(Array(3).fill([{ userId: owner.ownerId }, expect.stringMatching(/^select "role" from "organization_members"/)]));
  const audited = recorder.statements.filter((s) => /^insert into "audit"/.test(s.sql));
  expect(audited).toHaveLength(2);
  expect(await db.select({ workspaceId: audit.workspaceId, action: audit.action }).from(audit).where(eq(audit.action, "workspace.memberRemoved"))).toEqual([{ workspaceId, action: "workspace.memberRemoved" }]);
});

test("an invitation pending at a directory removal can't be accepted afterwards", async () => {
  const { owner, pat, db, organizationId, workspaceId } = await organization();
  await db.update(workspaceMembers).set({ role: "manager" }).where(eq(workspaceMembers.userId, "pat"));
  const issued = await call(router.workspace.invite, { organizationId, workspaceId, email: "sam@example.test", role: "member" }, { context: pat });
  const toPat = await call(router.workspace.invite, { organizationId, workspaceId: "sibling", email: "pat@example.com", role: "member" }, { context: owner });
  await call(api.unassign, { userId: "pat", workspaceId }, { context: owner });
  // The invitations Pat sent there are gone; the one to Pat for the sibling stays.
  expect((await db.select({ id: workspaceInvitations.id }).from(workspaceInvitations)).map((r) => r.id)).toEqual([toPat.id]);
  await call(api.removeMember, { userId: "pat" }, { context: owner });
  await expect(call(router.workspace.acceptInvitation, { token: toPat.token }, { context: pat })).rejects.toMatchObject(missing);
  expect(issued.id).toBeTruthy();
  expect(await db.select().from(organizationMembers).where(eq(organizationMembers.userId, "pat"))).toEqual([]);
  expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, "pat"))).toEqual([]);
});

test("removing someone from the organization takes every assignment and invitation there, and never the owner", async () => {
  const { owner, db, workspaceId } = await organization();
  await db.insert(workspaceMembers).values({ workspaceId: "sibling", userId: "pat", role: "manager" });
  await db.insert(organizationMembers).values({ organizationId: "foreign-org", userId: "pat", role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId: "foreign", userId: "pat", role: "member" });
  await call(api.removeMember, { userId: "pat" }, { context: owner });
  expect(await rolesOf(db, "pat")).toEqual([{ workspaceId: "foreign", role: "member" }]);
  expect(await db.select({ organizationId: organizationMembers.organizationId }).from(organizationMembers).where(eq(organizationMembers.userId, "pat"))).toEqual([{ organizationId: "foreign-org" }]);
  expect((await db.select({ workspaceId: audit.workspaceId }).from(audit).where(eq(audit.action, "workspace.organizationMemberRemoved"))).map((r) => r.workspaceId).sort()).toEqual([workspaceId, "sibling"].sort());
  await expect(call(api.removeMember, { userId: owner.ownerId }, { context: owner })).rejects.toMatchObject(missing);
  await expect(call(api.removeMember, { userId: "pat" }, { context: owner })).rejects.toMatchObject(missing);
  expect(await db.select().from(organizationMembers).where(eq(organizationMembers.userId, owner.ownerId))).toMatchObject([{ role: "owner" }]);
});

test("an organization has exactly one owner: a transfer demotes then promotes in one transaction, or changes nothing", async () => {
  const { owner, pat, db, organizationId } = await organization();
  const ownerOf = async () => (await db.select({ userId: organizationMembers.userId }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, "owner")))).map((r) => r.userId);
  // The index refuses a second owner set any other way.
  await expect(db.update(organizationMembers).set({ role: "owner" }).where(eq(organizationMembers.userId, "pat"))).rejects.toMatchObject({ cause: { code: "23505" } });
  // A transfer to someone removed meanwhile leaves the old owner in place.
  await db.insert(user).values({ id: "gone", name: "Gone", email: "gone@example.com" });
  await expect(call(api.transferOwnership, { userId: "gone" }, { context: owner })).rejects.toMatchObject(missing);
  expect(await ownerOf()).toEqual([owner.ownerId]);
  await call(api.transferOwnership, { userId: "pat" }, { context: owner });
  expect(await ownerOf()).toEqual(["pat"]);
  expect(await db.select({ details: audit.details }).from(audit).where(eq(audit.action, "workspace.ownershipTransferred"))).toHaveLength(2);
  // Of two competing transfers, the second finds its caller no longer the owner.
  await expect(call(api.transferOwnership, { userId: "pat" }, { context: owner })).rejects.toMatchObject(missing);
  await expect(call(api.directory, undefined, { context: owner })).rejects.toMatchObject(missing);
  await expect(call(api.directory, undefined, { context: pat })).resolves.toMatchObject({ people: expect.arrayContaining([expect.objectContaining({ userId: owner.ownerId, role: "member" })]) });
});

test("deleting a person archives them: no sign-in, no session, out of the organization, and no leftover row grants anything", async () => {
  const { owner, pat, db, organizationId, workspaceId } = await organization();
  await expect(call(api.archiveMember, { userId: owner.ownerId }, { context: owner })).rejects.toMatchObject(missing);
  await expect(call(api.archiveMember, { userId: "pat" }, { context: pat })).rejects.toMatchObject(missing);
  expect(await call(api.archiveMember, { userId: "pat" }, { context: owner })).toEqual({ archived: true });
  const [row] = await db.select({ archivedAt: user.archivedAt, archivedBy: user.archivedBy }).from(user).where(eq(user.id, "pat"));
  expect(row!.archivedAt).toBeInstanceOf(Date);
  expect(row!.archivedBy).toBe(organizationId);
  expect(await db.select().from(session).where(eq(session.userId, "pat"))).toEqual([]);
  await expect(call(router.workspace.mine, undefined, { context: pat })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(owner.auth.api.signInEmail({ body: { email: "pat@example.com", password: "pat's password" } })).rejects.toBeDefined();
  expect((await call(api.directory, undefined, { context: owner })).people.map((p) => p.userId)).toEqual([owner.ownerId]);
  expect(await db.select({ action: audit.action }).from(audit).where(eq(audit.action, "workspace.personArchived"))).toHaveLength(2);
  // Check at use: a membership written back by hand grants an archived person nothing.
  await db.insert(organizationMembers).values({ organizationId, userId: "pat", role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId, userId: "pat", role: "manager" });
  expect(await authorize(db, "pat", organizationId, workspaceId)).toBeNull();
});

test("a person who belongs to another organization too isn't archived from this one", async () => {
  const { owner, db } = await organization();
  await db.insert(organizationMembers).values({ organizationId: "foreign-org", userId: "pat", role: "member" });
  await expect(call(api.archiveMember, { userId: "pat" }, { context: owner })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await db.select({ archivedAt: user.archivedAt }).from(user).where(eq(user.id, "pat")))[0]!.archivedAt).toBeNull();
});
