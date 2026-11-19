import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { audit, organizationMembers, organizations, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

test("a workspace manager sees its effective members and revokes only the selected assignment", async () => {
  const context = await ownerContext();
  const { db, ownerId, workspaceId, organizationId } = context;
  const scope = { workspaceId, organizationId };
  for (const id of ["pat", "team-owner", "outside"]) await db.insert(user).values({ id, name: id, email: id + "@example.test" });
  await db.insert(organizations).values({ id: "foreign-org" });
  await db.insert(workspaces).values([{ id: "other", organizationId }, { id: "foreign", organizationId: "foreign-org" }]);
  await db.insert(organizationMembers).values([
    { organizationId, userId: "pat", role: "member" }, { organizationId, userId: "team-owner", role: "owner" },
    { organizationId: "foreign-org", userId: "outside", role: "owner" },
  ]);
  await db.insert(workspaceMembers).values([
    { workspaceId, userId: ownerId, role: "manager" }, { workspaceId, userId: "pat", role: "member" },
    { workspaceId, userId: "team-owner", role: "member" }, { workspaceId: "other", userId: "pat", role: "manager" },
    { workspaceId, userId: "outside", role: "manager" },
  ]);
  const list = (s = scope) => call(router.workspace.people, s, { context });
  const remove = (userId: string, s = scope) => call(router.workspace.removePerson, { ...s, userId }, { context });
  expect(await call(router.workspace.managed, undefined, { context })).toHaveLength(2);
  expect(await list({ workspaceId: "other", organizationId })).toContainEqual(expect.objectContaining({ userId: ownerId, role: "owner" }));
  await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, ownerId));
  expect(await call(router.workspace.managed, undefined, { context })).toEqual([scope]);
  expect((await list()).map(({ userId, role }) => [userId, role]).sort()).toEqual([[ownerId, "manager"], ["pat", "member"], ["team-owner", "owner"]].sort());
  const denied = { code: "NOT_FOUND" };
  await expect(list({ ...scope, organizationId: "foreign-org" })).rejects.toMatchObject(denied);
  await expect(remove("pat", { workspaceId: "other", organizationId })).rejects.toMatchObject(denied);
  await expect(remove("team-owner")).rejects.toMatchObject(denied);
  await expect(remove("outside")).rejects.toMatchObject(denied);
  const job = { ...context, job: { runId: "job", ownerId, agentId: "agent" } };
  await expect(call(router.workspace.removePerson, { ...scope, userId: "pat" }, { context: job })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(remove("pat")).resolves.toEqual({ removed: true });
  expect(await list()).not.toContainEqual(expect.objectContaining({ userId: "pat" }));
  expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, "pat"))).toEqual([{ workspaceId: "other", userId: "pat", role: "manager" }]);
  expect(await db.select().from(audit).where(eq(audit.action, "workspace.memberRemoved"))).toMatchObject([{ actor: { type: "user", userId: ownerId }, resourceId: workspaceId, details: { userId: "pat" } }]);
  await expect(remove("pat")).rejects.toMatchObject(denied);
  await db.update(workspaceMembers).set({ role: "member" }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, ownerId)));
  expect(await call(router.workspace.managed, undefined, { context })).toEqual([]);
  await expect(list()).rejects.toMatchObject(denied);
  await expect(remove(ownerId)).rejects.toMatchObject(denied);
});
