import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { pingDb } from "../db/client.ts";
import { type Ambient, currentScope, SYSTEM } from "../db/scope.ts";
import { artifacts, messages, stepRuns, workspaces } from "../db/schema.ts";
import { recordScopes } from "../db/test-support.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "../workspace/authorize.ts";
import { base, manager, member, orgOwner, signedIn } from "./context.ts";
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

test("health, auth.status and auth.setup's count run under SYSTEM on the guarded db", { tags: ["pglite-only"] }, async () => {
  const { context, statements, setupCode } = await guarded();
  await pingDb(context.db);
  expect(await call(router.auth.status, undefined, { context })).toEqual({ needsSetup: false, enrollsAccounts: true });
  const second = { name: "Bob", email: "bob@example.com", password: "correct horse battery", setupCode };
  await expect(call(router.auth.setup, second, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(statements.length).toBe(3);
  expect(statements.every((s) => s.scope === SYSTEM)).toBe(true);
});

test("a signed-in procedure sees { userId }", { tags: ["pglite-only"] }, async () => {
  const { context, ownerId } = await guarded();
  expect(await call(base.use(signedIn).handler(() => currentScope()), undefined, { context })).toEqual({ userId: ownerId });
});

test("a Job's signed-in call runs in its run's scope", { tags: ["pglite-only"] }, async () => {
  const { owner, context, ownerId, organizationId, workspaceId } = await guarded();
  const job = await jobIdentity(owner);
  expect(await call(base.use(signedIn).handler(() => currentScope()), undefined, { context: { ...context, job } })).toEqual({ userId: ownerId, organizationId, workspaceId });
});

/** Statements on `runs` sent under a person alone: what a database adapter that keeps runs to a workspace would answer with no row. */
const personOnlyRunReads = (statements: { scope: Ambient; sql: string }[]) =>
  statements.filter((s) => s.scope !== SYSTEM && !s.scope.workspaceId && /"runs"/.test(s.sql)).map((s) => s.sql);

test("a Job's member call finds its run under SYSTEM or in its run's scope", { tags: ["pglite-only"] }, async () => {
  const { owner, context, ownerId, organizationId, workspaceId, statements } = await guarded();
  const job = await jobIdentity(owner);
  statements.length = 0;
  expect(await call(base.use(member).handler(() => currentScope()), undefined, { context: { ...context, job } })).toEqual({ userId: ownerId, organizationId, workspaceId });
  expect(personOnlyRunReads(statements)).toEqual([]);
});

test("a Job of another workspace's run is admitted nowhere", { tags: ["pglite-only"] }, async () => {
  const { owner, context } = await guarded();
  const job = await jobIdentity(owner);
  await owner.db.insert(workspaces).values({ id: "elsewhere", organizationId: owner.organizationId });
  await expect(call(base.use(signedIn).handler(() => currentScope()), undefined, { context: { ...context, job: { ...job, workspaceId: "elsewhere" } } })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("jobs.get, jobs.def, runs.get and artifacts.get read a run in its workspace's scope, for a person and for a Job", { tags: ["pglite-only"] }, async () => {
  const { owner, context, statements } = await guarded();
  const job = await jobIdentity(owner);
  await owner.db.insert(stepRuns).values({ id: "shown-step", runId: job.runId, nodeId: "node", status: "running" });
  await owner.db.insert(messages).values({ id: "shown-message", ownerId: owner.ownerId, runId: job.runId, stepRunId: "shown-step", role: "assistant", text: "" });
  await owner.db.insert(artifacts).values({ id: "shown", runId: job.runId, stepRunId: "shown-step", messageId: "shown-message", title: "Chart", format: "svg", code: "<svg/>" });
  statements.length = 0;
  for (const caller of [context, { ...context, job }]) {
    await expect(call(router.jobs.get, { id: job.runId }, { context: caller })).resolves.toMatchObject({ id: job.runId });
    await expect(call(router.jobs.def, { runId: job.runId }, { context: caller })).resolves.toBeTruthy();
  }
  await expect(call(router.runs.get, { runId: job.runId }, { context })).resolves.toMatchObject({ run: { id: job.runId } });
  await expect(call(router.artifacts.get, { id: "shown" }, { context })).resolves.toMatchObject({ id: "shown" });
  expect(personOnlyRunReads(statements)).toEqual([]);
});

test("member and orgOwner procedures see what they admitted", { tags: ["pglite-only"] }, async () => {
  const { context, ownerId, organizationId, workspaceId } = await guarded();
  const headers = new Headers(context.headers);
  headers.set(ORGANIZATION_HEADER, organizationId);
  headers.set(WORKSPACE_HEADER, workspaceId);
  const named = { ...context, headers };
  expect(await call(base.use(member).handler(() => currentScope()), undefined, { context: named })).toEqual({ userId: ownerId, organizationId, workspaceId });
  expect(await call(base.use(orgOwner).handler(() => currentScope()), undefined, { context: named })).toEqual({ userId: ownerId, organizationId });
});

test("member and manager give a procedure its access and its actor, and no owner to filter by", { tags: ["pglite-only"] }, async () => {
  const { context: withOwner, ownerId, organizationId, workspaceId } = await guarded();
  // A procedure's context starts from what the server gives a request, which names no owner.
  const context: Omit<typeof withOwner, "ownerId"> = Object.fromEntries(Object.entries(withOwner).filter(([key]) => key !== "ownerId")) as never;
  const seen = (gate: typeof member) => call(base.use(gate).handler(({ context: c }) => ({ hasOwner: "ownerId" in c, actorId: c.actorId, access: c.access })), undefined, { context });
  for (const gate of [member, manager]) {
    expect(await seen(gate)).toEqual({ hasOwner: false, actorId: ownerId, access: { userId: ownerId, organizationId, workspaceId, role: "owner" } });
  }
});

test("a member procedure on the guarded db runs without throwing", { tags: ["pglite-only"] }, async () => {
  const { context } = await guarded();
  const { runnerId } = await call(router.runners.create, { name: "Scoped" }, { context });
  const listed = await call(router.runners.list, undefined, { context });
  expect(listed.map((r) => r.id)).toContain(runnerId);
});
