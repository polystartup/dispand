import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { account, audit, organizationMembers, organizations, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

async function fixture() {
  const context = await ownerContext();
  const { db, organizationId, workspaceId } = context;
  const email = "pat@example.test";
  const password = "this is pat's password";
  const auth = await context.auth.$context;
  await db.insert(user).values({ id: "pat", name: "Pat", email });
  await db.insert(account).values({ id: "acct_pat", accountId: "pat", userId: "pat", providerId: "credential", password: await auth.password.hash(password) });
  const login = await context.auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const pat = { ...context, headers: new Headers({ cookie: login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  const scope = { organizationId, workspaceId };
  const api = router.workspace;
  const issue = (where = scope) => call(api.invite, { ...where, email: "PAT@example.test", role: "member" }, { context });
  const accept = (token: string) => call(api.acceptInvitation, { token }, { context: pat });
  return { api, context, pat, scope, issue, accept };
}

test("only the intended signed-in account may see and accept the latest invitation once", async () => {
  const { api, context, pat, scope, issue, accept } = await fixture();
  const { db } = context;
  await db.insert(organizations).values({ id: "other" });
  await db.insert(organizationMembers).values({ organizationId: "other", userId: "pat", role: "owner" });
  const old = await issue();
  const current = await issue();
  const missing = { code: "NOT_FOUND" };
  await expect(accept(old.token)).rejects.toMatchObject(missing);
  await expect(call(api.invitation, { token: current.token }, { context })).rejects.toMatchObject(missing);
  await expect(call(api.acceptInvitation, { token: current.token }, { context })).rejects.toMatchObject(missing);
  expect(await call(api.invitation, { token: current.token }, { context: pat })).toMatchObject({ ...scope, role: "member", inviterName: "Ada" });
  const pending = await call(api.invitations, scope, { context });
  expect(pending).toMatchObject([{ id: current.id, email: "pat@example.test", role: "member" }]);
  expect(JSON.stringify([pending, await db.select().from(workspaceInvitations)])).not.toContain(current.token);
  const results = await Promise.allSettled([accept(current.token), accept(current.token)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await db.select().from(organizationMembers).where(eq(organizationMembers.userId, "pat")).orderBy(organizationMembers.role)).toMatchObject([{ role: "member" }, { role: "owner" }]);
  expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, "pat"))).toEqual([{ workspaceId: scope.workspaceId, userId: "pat", role: "member" }]);
  expect(await db.select({ actor: audit.actor }).from(audit).where(eq(audit.action, "workspace.invitationAccepted"))).toEqual([{ actor: { type: "user", userId: "pat" } }]);
  const pendingAtRemoval = await issue();
  await call(api.removePerson, { ...scope, userId: "pat" }, { context });
  await expect(accept(pendingAtRemoval.token)).rejects.toMatchObject(missing);
  await expect(accept(current.token)).rejects.toMatchObject(missing);
});

test("inviting and revoking require current authority in the named workspace", async () => {
  const { api, context, scope, issue, accept } = await fixture();
  const { db, ownerId } = context;
  const missing = { code: "NOT_FOUND" };
  await db.insert(workspaces).values({ id: "sibling", organizationId: scope.organizationId });
  await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, ownerId));
  await db.insert(workspaceMembers).values({ workspaceId: scope.workspaceId, userId: ownerId, role: "manager" });
  await expect(issue({ ...scope, workspaceId: "sibling" })).rejects.toMatchObject(missing);
  await expect(issue({ ...scope, organizationId: "foreign" })).rejects.toMatchObject(missing);
  const first = await issue();
  await expect(call(api.revokeInvitation, { ...scope, workspaceId: "sibling", id: first.id }, { context })).rejects.toMatchObject(missing);
  await call(api.revokeInvitation, { ...scope, id: first.id }, { context });
  await expect(accept(first.token)).rejects.toMatchObject(missing);
  const second = await issue();
  await db.update(workspaceInvitations).set({ expiresAt: new Date(0) }).where(eq(workspaceInvitations.id, second.id));
  await expect(accept(second.token)).rejects.toMatchObject(missing);
  const job = { ...context, job: { ownerId, agentId: "agent", runId: "run" } };
  await expect(call(api.invite, { ...scope, email: "pat@example.test", role: "member" }, { context: job })).rejects.toMatchObject({ code: "FORBIDDEN" });
  const last = await issue();
  await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.userId, ownerId)));
  await expect(accept(last.token)).rejects.toMatchObject(missing);
  expect(await db.select().from(workspaceMembers)).toEqual([]);
});

test("the installation owner can onboard a new identity by trusted handoff without taking over an existing account", async () => {
  const { api, context, scope } = await fixture();
  const email = "new@example.test";
  const password = "the invited user's new password";
  const { token } = await call(api.invite, { ...scope, email, role: "manager" }, { context });
  const anonymous = { ...context, headers: new Headers() };
  const register = (value: string, targetEmail = email) => call(api.registerInvitation, { token: value, name: "New", email: targetEmail, password }, { context: anonymous });
  await expect(register(token, "different@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(register(token)).resolves.toEqual(scope);
  await expect(register(token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const login = await context.auth.api.signInEmail({ body: { email, password } });
  expect(login.user.email).toBe(email);
  expect(await context.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, login.user.id))).toEqual([{ workspaceId: scope.workspaceId, userId: login.user.id, role: "manager" }]);
  const existing = await call(api.invite, { ...scope, email: "pat@example.test", role: "member" }, { context });
  await expect(register(existing.token, "pat@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await context.db.select().from(workspaceInvitations).where(eq(workspaceInvitations.id, existing.id))).toHaveLength(1);
  await context.db.insert(organizations).values({ id: "another-org" });
  await context.db.insert(workspaces).values({ id: "another-workspace", organizationId: "another-org" });
  const other = await call(api.invite, { ...scope, email: "other@example.test", role: "member" }, { context });
  await expect(register(other.token, "other@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
});
