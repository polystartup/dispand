import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { currentScope, SYSTEM } from "../db/scope.ts";
import { organizationMembers, runners, user, workspaceInvitations, workspaceMembers } from "../db/schema.ts";
import { recordScopes } from "../db/test-support.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

/** The owner's install with Pat a member, seeded on the plain database, then served from the guarded one. */
async function directory() {
  const owner = await ownerContext();
  const { db, organizationId, workspaceId } = owner;
  await db.insert(user).values({ id: "pat", name: "Pat", email: "pat@example.test" });
  await db.insert(organizationMembers).values({ organizationId, userId: "pat", role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId, userId: "pat", role: "member" });
  const recorder = await recordScopes(db);
  return { owner, scope: { organizationId, workspaceId }, statements: recorder.statements, context: { ...owner, db: recorder.db } };
}

/**
 * Statements sent under a person alone, other than their own membership check (`authorize`, which
 * reads from `workspaces`): what a database adapter that keeps the directory to a workspace answers
 * with no row.
 */
const personOnly = (statements: { scope: unknown; sql: string }[]) =>
  statements.filter((s) => s.scope !== SYSTEM && !(s.scope as { workspaceId?: string }).workspaceId && !/^select .* from "workspaces" inner join "organization_members"/.test(s.sql)).map((s) => s.sql);

test("People and invitations run in the workspace's scope once the caller's role is checked", { tags: ["pglite-only"] }, async () => {
  const { context, scope, statements } = await directory();
  expect((await call(router.workspace.people, scope, { context })).map((p) => p.userId)).toContain("pat");
  const { id } = await call(router.workspace.invite, { ...scope, email: "sam@example.test", role: "member" }, { context });
  expect(await call(router.workspace.invitations, scope, { context })).toMatchObject([{ id }]);
  await call(router.workspace.revokeInvitation, { ...scope, id }, { context });
  await call(router.workspace.removePerson, { ...scope, userId: "pat" }, { context });
  expect(personOnly(statements)).toEqual([]);
});

test("removePerson deletes the invitations addressed to them, in the same transaction, before their assignment", { tags: ["pglite-only"] }, async () => {
  const { owner, context, scope, statements } = await directory();
  await call(router.workspace.invite, { ...scope, email: "pat@example.test", role: "manager" }, { context });
  statements.length = 0;
  await call(router.workspace.removePerson, { ...scope, userId: "pat" }, { context });
  expect(await owner.db.select().from(workspaceInvitations)).toEqual([]);
  const invitations = statements.findIndex((s) => /^delete from "workspace_invitations"/.test(s.sql));
  const assignment = statements.findIndex((s) => /^delete from "workspace_members"/.test(s.sql));
  expect(invitations).toBeGreaterThanOrEqual(0);
  expect(invitations).toBeLessThan(assignment);
  expect(statements[invitations]!.scope).toMatchObject(scope);
});

test("a manager revokes, in the workspace's scope, a runner a removed person registered", { tags: ["pglite-only"] }, async () => {
  const { owner, context, scope, statements } = await directory();
  await owner.db.insert(runners).values({ id: "pats-runner", ownerId: "pat", workspaceId: scope.workspaceId, name: "Pat's" });
  await call(router.workspace.removePerson, { ...scope, userId: "pat" }, { context });
  statements.length = 0;
  // The engine keeps its own database handle: its cleanup's scope is checked where it is called.
  const cleanup: unknown[] = [];
  context.engine.runnerRevoked = async () => void cleanup.push(currentScope());
  await call(router.runners.revoke, { runnerId: "pats-runner" }, { context });
  expect(cleanup).toEqual([{ userId: owner.ownerId, ...scope }]);
  const [runner] = await owner.db.select({ revokedAt: runners.revokedAt }).from(runners).where(eq(runners.id, "pats-runner"));
  expect(runner!.revokedAt).not.toBeNull();
  expect(personOnly(statements)).toEqual([]);
});

test("a directory write re-checks the role in its transaction, with no lock", { tags: ["pglite-only"] }, async () => {
  const { context, scope, statements } = await directory();
  await call(router.workspace.invite, { ...scope, email: "sam@example.test", role: "member" }, { context });
  const writes = statements.findIndex((s) => /^insert into "workspace_invitations"/.test(s.sql));
  expect(statements.slice(0, writes).filter((s) => /from "workspaces" inner join "organization_members"/.test(s.sql)).length).toBeGreaterThanOrEqual(2);
  expect(statements.filter((s) => /pg_advisory_xact_lock|\bfor update\b/i.test(s.sql))).toEqual([]);
});
