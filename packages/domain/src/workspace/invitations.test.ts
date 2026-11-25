import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, createDb } from "../db/client.ts";
import { account, audit, organizationMembers, organizations, runs, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, recordScopes } from "../runners/test-support.ts";
import { inScope, SYSTEM } from "../db/scope.ts";

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
  await db.update(organizations).set({ name: "Northwind" }).where(eq(organizations.id, scope.organizationId));
  await db.update(workspaces).set({ name: "Design" }).where(eq(workspaces.id, scope.workspaceId));
  await db.insert(organizations).values({ id: "other" });
  await db.insert(organizationMembers).values({ organizationId: "other", userId: "pat", role: "owner" });
  const old = await issue();
  const current = await issue();
  const missing = { code: "NOT_FOUND" };
  await expect(accept(old.token)).rejects.toMatchObject(missing);
  await expect(call(api.invitation, { token: current.token }, { context })).rejects.toMatchObject(missing);
  await expect(call(api.acceptInvitation, { token: current.token }, { context })).rejects.toMatchObject(missing);
  expect(await call(api.invitation, { token: current.token }, { context: pat })).toMatchObject({ ...scope, organizationName: "Northwind", workspaceName: "Design", role: "member", inviterName: "Ada" });
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
  await db.insert(runs).values({ id: "run", workspaceId: context.workspaceId, ownerId: ownerId, source: "agent", version: 0, status: "running" });
  const job = { ...context, job: { ownerId, workspaceId: context.workspaceId, agentId: "agent", runId: "run" } };
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
  const preview = (token: string, email: string) => call(api.registrationPreview, { token, email }, { context: anonymous });
  await expect(preview(token, "different@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(preview(token, email)).resolves.toMatchObject({ ...scope, organizationName: "My organization", workspaceName: "Main workspace", inviterName: "Ada", role: "manager" });
  await expect(register(token, "different@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(register(token)).resolves.toEqual(scope);
  await expect(register(token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const login = await context.auth.api.signInEmail({ body: { email, password } });
  expect(login.user.email).toBe(email);
  expect(await context.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, login.user.id))).toEqual([{ workspaceId: scope.workspaceId, userId: login.user.id, role: "manager" }]);
  const existing = await call(api.invite, { ...scope, email: "pat@example.test", role: "member" }, { context });
  await expect(preview(existing.token, "pat@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(register(existing.token, "pat@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await context.db.select().from(workspaceInvitations).where(eq(workspaceInvitations.id, existing.id))).toHaveLength(1);
  const other = await call(api.invite, { ...scope, email: "other@example.test", role: "member" }, { context });
  // A server whose people come from another flow enrolls nobody through an invitation.
  const elsewhere = { ...anonymous, setup: false };
  await expect(call(api.registrationPreview, { token: other.token, email: "other@example.test" }, { context: elsewhere })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(api.registerInvitation, { token: other.token, name: "New", email: "other@example.test", password }, { context: elsewhere })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // An organization owner no longer: their invitation enrolls nobody, checked when it is used.
  await context.db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, context.ownerId));
  await context.db.insert(workspaceMembers).values({ workspaceId: scope.workspaceId, userId: context.ownerId, role: "manager" });
  await expect(preview(other.token, "other@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(register(other.token, "other@example.test")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("the registration preview refuses an email whose account is on a separate authDb only", async () => {
  const { api, context, scope } = await fixture();
  const email = "elsewhere@example.test";
  const { token } = await call(api.invite, { ...scope, email, role: "member" }, { context });
  // A database adapter may serve identities on their own handle, and db may see only the workspace's people.
  const authDb = await createDb("pglite://memory");
  onTestFinished(() => closeDb(authDb));
  await authDb.insert(user).values({ id: "elsewhere", name: "Elsewhere", email });
  const preview = (handle: typeof authDb) => call(api.registrationPreview, { token, email }, { context: { ...context, authDb: handle, headers: new Headers() } });
  await expect(preview(context.db)).resolves.toMatchObject(scope);
  await expect(preview(authDb)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("an invitation token resolves its workspace under SYSTEM, then is read and accepted in that workspace, on the guarded db", async () => {
  const { api, context, pat, scope, issue } = await fixture();
  const { token } = await issue();
  const recorder = await recordScopes(context.db);
  const guarded = { ...pat, db: recorder.db, authDb: recorder.db };
  const from = <T>(work: () => Promise<T>) => inScope({ workspaceId: "ws_other" }, work);
  await from(() => call(api.invitation, { token }, { context: guarded }));
  await from(() => call(api.acceptInvitation, { token }, { context: guarded }));
  const patScope = { userId: "pat", ...scope };
  // Each call: the token's workspace under SYSTEM, then every statement in the person's scope there.
  const systemAt = recorder.statements.flatMap((st, i) => (st.scope === SYSTEM ? [i] : []));
  expect(systemAt).toHaveLength(2);
  for (const [i, { scope: seen }] of recorder.statements.entries()) if (!systemAt.includes(i)) expect(seen).toEqual(patScope);
  recorder.statements.length = 0;
  await expect(from(() => call(api.acceptInvitation, { token }, { context: guarded }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(recorder.statements.map((st) => st.scope)).toEqual([SYSTEM]);
});

test("a registration by invitation runs in the invitation's workspace, as the new person once known, on the guarded db", async () => {
  const { api, context, scope } = await fixture();
  const email = "new@example.test";
  const { token } = await call(api.invite, { ...scope, email, role: "member" }, { context });
  const recorder = await recordScopes(context.db);
  const anonymous = { ...context, db: recorder.db, authDb: recorder.db, headers: new Headers() };
  const from = <T>(work: () => Promise<T>) => inScope({ workspaceId: "ws_other" }, work);
  await from(() => call(api.registrationPreview, { token, email }, { context: anonymous }));
  expect(await from(() => call(api.registerInvitation, { token, email, name: "New", password: "the new person's password" }, { context: anonymous }))).toEqual(scope);
  const seen = recorder.statements.map((st) => st.scope);
  expect(seen.filter((s) => s === SYSTEM)).toHaveLength(2);
  for (const s of seen) if (s !== SYSTEM) expect(s).toMatchObject(scope);
  const [created] = await context.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  expect(seen.at(-1)).toEqual({ userId: created!.id, ...scope });
});
