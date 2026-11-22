import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { organizationMembers, organizations, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { base, manager, member, orgOwner } from "../rpc/context.ts";
import { router } from "../rpc/router.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { authorize, resolveWorkspace } from "./authorize.ts";

/** The owner's install with a second workspace B, a member of the main one and a foreign organization. */
async function install() {
  const context = await ownerContext();
  // Started while the install has one workspace, as Jobs are today.
  const job = await jobIdentity(context);
  const { db, organizationId } = context;
  await db.insert(user).values([{ id: "pat", name: "Pat", email: "pat@example.test" }, { id: "outside", name: "Outside", email: "outside@example.test" }]);
  await db.insert(organizations).values({ id: "foreign-org" });
  await db.insert(workspaces).values([{ id: "b", organizationId, name: "B" }, { id: "foreign", organizationId: "foreign-org" }]);
  await db.insert(organizationMembers).values([{ organizationId, userId: "pat", role: "member" }, { organizationId: "foreign-org", userId: "outside", role: "owner" }]);
  await db.insert(workspaceMembers).values({ workspaceId: context.workspaceId, userId: "pat", role: "member" });
  return { ...context, startedJob: job };
}

test("authorize gives organization owners owner everywhere, members their workspace role, and nothing elsewhere", async () => {
  const { db, ownerId, organizationId, workspaceId } = await install();
  expect(await authorize(db, ownerId, organizationId, "b")).toBe("owner");
  expect(await authorize(db, "pat", organizationId, workspaceId)).toBe("member");
  expect(await authorize(db, "pat", organizationId, "b")).toBeNull();
  expect(await authorize(db, "outside", organizationId, workspaceId)).toBeNull();
  // The workspace must be the named organization's.
  expect(await authorize(db, "outside", "foreign-org", workspaceId)).toBeNull();
  expect(await authorize(db, ownerId, "foreign-org", "foreign")).toBeNull();
  await db.update(workspaceMembers).set({ role: "manager" }).where(eq(workspaceMembers.userId, "pat"));
  expect(await authorize(db, "pat", organizationId, workspaceId)).toBe("manager");
  // Never cached: a removal applies on the next call.
  await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "pat"));
  expect(await authorize(db, "pat", organizationId, workspaceId)).toBeNull();
});

test("resolveWorkspace takes the headers, else the only workspace a person can open", async () => {
  const { db, ownerId, organizationId, workspaceId } = await install();
  const headers = (h: Record<string, string> = {}) => new Headers(h);
  expect(await resolveWorkspace(db, "pat", headers())).toEqual({ organizationId, workspaceId });
  expect(await resolveWorkspace(db, ownerId, headers())).toBeNull();
  expect(await resolveWorkspace(db, "outside", headers())).toEqual({ organizationId: "foreign-org", workspaceId: "foreign" });
  // Headers are taken as they are: authorize refuses later, not resolve.
  const named = { "dispand-organization": organizationId, "dispand-workspace": "b" };
  expect(await resolveWorkspace(db, "pat", headers(named))).toEqual({ organizationId, workspaceId: "b" });
  // Half a pair names no workspace, and doesn't fall back to the default either.
  expect(await resolveWorkspace(db, "pat", headers({ "dispand-workspace": workspaceId }))).toBeNull();
  expect(await resolveWorkspace(db, "pat", headers({ "dispand-workspace": "" }))).toBeNull();
  expect(await resolveWorkspace(db, "pat", headers({ "dispand-organization": "", "dispand-workspace": "" }))).toBeNull();
});

test("member, manager and orgOwner admit by the live role of the workspace the request names", async () => {
  const context = await install();
  const { organizationId, workspaceId, ownerId } = context;
  const probe = { member: base.use(member).handler(({ context }) => context.access), manager: base.use(manager).handler(({ context }) => context.access), orgOwner: base.use(orgOwner).handler(({ context }) => context.access) };
  const as = (headers: Record<string, string>) => ({ ...context, headers: new Headers({ ...Object.fromEntries(context.headers), ...headers }) });
  const inB = as({ "dispand-organization": organizationId, "dispand-workspace": "b" });
  expect(await call(probe.member, undefined, { context: inB })).toEqual({ organizationId, workspaceId: "b", userId: ownerId, role: "owner" });
  expect(await call(probe.manager, undefined, { context: inB })).toMatchObject({ role: "owner" });
  expect(await call(probe.orgOwner, undefined, { context: as({ "dispand-organization": organizationId }) })).toEqual({ organizationId, userId: ownerId, role: "owner" });
  // Two openable workspaces and no headers: no default.
  await expect(call(probe.member, undefined, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(probe.member, undefined, { context: as({ "dispand-organization": "foreign-org", "dispand-workspace": "foreign" }) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(probe.orgOwner, undefined, { context: as({ "dispand-organization": "foreign-org" }) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // A plain member is a member, not a manager, and owns no organization.
  await context.db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, ownerId));
  await context.db.insert(workspaceMembers).values({ workspaceId, userId: ownerId, role: "member" });
  const inMain = as({ "dispand-organization": organizationId, "dispand-workspace": workspaceId });
  expect(await call(probe.member, undefined, { context: inMain })).toMatchObject({ role: "member" });
  await expect(call(probe.manager, undefined, { context: inMain })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(probe.orgOwner, undefined, { context: as({ "dispand-organization": organizationId }) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // One openable workspace left: it is the default.
  expect(await call(probe.member, undefined, { context })).toMatchObject({ workspaceId, role: "member" });
  await expect(call(probe.member, undefined, { context: { ...context, headers: new Headers() } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a Job is a member of its run's workspace, whatever the request says", async () => {
  const context = await install();
  const job = context.startedJob;
  const probe = { member: base.use(member).handler(({ context }) => context.access), manager: base.use(manager).handler(({ context }) => context.access) };
  const asJob = { ...context, job, headers: new Headers({ "dispand-organization": context.organizationId, "dispand-workspace": "b" }) };
  expect(await call(probe.member, undefined, { context: asJob })).toEqual({ organizationId: context.organizationId, workspaceId: context.workspaceId, userId: context.ownerId, role: "member" });
  await expect(call(probe.manager, undefined, { context: asJob })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(probe.member, undefined, { context: { ...asJob, job: { ...job, runId: "no-such-run" } } })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("workspace.mine lists the workspaces a person can open with their role, and no Job's", async () => {
  const context = await install();
  const { organizationId, workspaceId } = context;
  expect(await call(router.workspace.mine, undefined, { context })).toEqual([
    { organizationId, workspaceId: "b", name: "B", role: "owner" },
    { organizationId, workspaceId, name: "Main workspace", role: "owner" },
  ]);
  await expect(call(router.workspace.mine, undefined, { context: { ...context, job: context.startedJob } })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
