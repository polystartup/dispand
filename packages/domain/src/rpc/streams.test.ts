import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { SYSTEM } from "../db/scope.ts";
import { session } from "../db/schema.ts";
import { jobIdentity, ownerContext, recordScopes } from "../runners/test-support.ts";
import { router } from "./router.ts";

// A stream's body runs in whoever calls `next()`: here the test itself, with no scope. On the
// guarded db, every read must then set its own: the person alone to re-admit them, then the workspace.
async function guarded() {
  const owner = await ownerContext();
  const recorder = await recordScopes(owner.db);
  const { ownerId: userId, organizationId, workspaceId } = owner;
  const expectScoped = () => {
    for (const { scope } of recorder.statements) expect([SYSTEM, { userId }, { userId, organizationId, workspaceId }]).toContainEqual(scope);
    expect(recorder.statements.some((st) => st.scope !== SYSTEM && st.scope.workspaceId === workspaceId)).toBe(true);
  };
  return { owner, context: { ...owner, db: recorder.db }, recorder, expectScoped };
}

test("rows.stream reads and re-admits in scope, from a caller with none", async () => {
  const { owner, context, expectScoped } = await guarded();
  const table = await call(router.tables.create, { name: "Projects" }, { context: owner });
  const abort = new AbortController();
  const stream = await call(router.rows.stream, { tableIds: [table.id] }, { context, signal: abort.signal });
  const first = stream.next();
  const row = await call(router.rows.create, { tableId: table.id }, { context: owner });
  expect((await first).value).toEqual({ type: "rows", tableId: table.id, rowIds: [row.id] });
  expectScoped();
  abort.abort();
  await stream.return?.(undefined);
});

test("questions.stream counts in scope, from a caller with none", async () => {
  const { owner, context, expectScoped } = await guarded();
  const abort = new AbortController();
  const stream = await call(router.questions.stream, undefined, { context, signal: abort.signal });
  expect((await stream.next()).value).toEqual({ count: 0 });
  owner.engine.questionChanged(owner.workspaceId);
  expect((await stream.next()).value).toEqual({ count: 0 });
  expectScoped();
  abort.abort();
  await stream.return?.(undefined);
});

test("runs.stream reads its snapshot and events in the run's workspace, from a caller with none", async () => {
  const { owner, context, expectScoped } = await guarded();
  const { runId } = await jobIdentity(owner);
  const abort = new AbortController();
  const stream = await call(router.runs.stream, { runId }, { context, signal: abort.signal });
  const first = await stream.next();
  expect(first.value).toMatchObject({ type: "snapshot", run: { id: runId } });
  const { run } = first.value as unknown as { run: never };
  owner.engine.events.publish(runId, { type: "run", run });
  expect((await stream.next()).value).toMatchObject({ type: "run" });
  expectScoped();
  abort.abort();
  await stream.return?.(undefined);
});

test("a stream ends on its next event once its session is gone", async () => {
  const { owner, context } = await guarded();
  const table = await call(router.tables.create, { name: "Projects" }, { context: owner });
  const abort = new AbortController();
  const stream = await call(router.rows.stream, { tableIds: [table.id] }, { context, signal: abort.signal });
  const first = stream.next();
  await call(router.rows.create, { tableId: table.id }, { context: owner });
  await first;
  await owner.db.delete(session);
  owner.dataEvents.publish({ type: "rows", tableId: table.id, rowIds: [] });
  await expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  abort.abort();
});
