import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { pingDb } from "../db/client.ts";
import { currentScope, SYSTEM } from "../db/scope.ts";
import { recordScopes } from "../db/test-support.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "../workspace/authorize.ts";
import { authed, base, member, orgOwner, signedIn } from "./context.ts";
import { router } from "./router.ts";

/**
 * The owner's install, seeded on the plain database, then served from the guarded one: domain
 * statements with no scope throw. Better Auth keeps the plain one, as it would its own login.
 */
async function guarded() {
  const owner = await ownerContext();
  const recorder = await recordScopes(owner.db);
  const { ownerId, organizationId, workspaceId, setupCode } = owner;
  return { owner, ownerId, organizationId, workspaceId, setupCode, statements: recorder.statements, context: { ...owner, db: recorder.db } };
}

test("health, auth.status and auth.setup's count run under SYSTEM on the guarded db", async () => {
  const { context, statements, setupCode } = await guarded();
  await pingDb(context.db);
  expect(await call(router.auth.status, undefined, { context })).toEqual({ needsSetup: false });
  const second = { name: "Bob", email: "bob@example.com", password: "correct horse battery", setupCode };
  await expect(call(router.auth.setup, second, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(statements.length).toBe(3);
  expect(statements.every((s) => s.scope === SYSTEM)).toBe(true);
});

test("a signed-in procedure sees { userId }", async () => {
  const { context, ownerId } = await guarded();
  expect(await call(base.use(signedIn).handler(() => currentScope()), undefined, { context })).toEqual({ userId: ownerId });
});

test("a Job's signed-in call sees its owner", async () => {
  const { owner, context, ownerId } = await guarded();
  const job = await jobIdentity(owner);
  expect(await call(base.use(signedIn).handler(() => currentScope()), undefined, { context: { ...context, job } })).toEqual({ userId: ownerId });
});

test("an authed procedure sees the workspace and organization", async () => {
  const { context, ownerId, organizationId, workspaceId } = await guarded();
  expect(await call(base.use(authed).handler(() => currentScope()), undefined, { context })).toEqual({ userId: ownerId, organizationId, workspaceId });
});

test("member and orgOwner procedures see what they admitted", async () => {
  const { context, ownerId, organizationId, workspaceId } = await guarded();
  const headers = new Headers(context.headers);
  headers.set(ORGANIZATION_HEADER, organizationId);
  headers.set(WORKSPACE_HEADER, workspaceId);
  const named = { ...context, headers };
  expect(await call(base.use(member).handler(() => currentScope()), undefined, { context: named })).toEqual({ userId: ownerId, organizationId, workspaceId });
  expect(await call(base.use(orgOwner).handler(() => currentScope()), undefined, { context: named })).toEqual({ userId: ownerId, organizationId });
});

test("an authed procedure on the guarded db runs without throwing", async () => {
  const { context } = await guarded();
  const { runnerId } = await call(router.runners.create, { name: "Scoped" }, { context });
  const listed = await call(router.runners.list, undefined, { context });
  expect(listed.map((r) => r.id)).toContain(runnerId);
});
