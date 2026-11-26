import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { organizationMembers, workspaceMembers } from "../db/schema.ts";
import { jobIdentity, ownerContext, personContext, refusing } from "../runners/test-support.ts";
import { router } from "./router.ts";

const LINK = "/organization-settings";
const RECHECK_MS = 7;

// An owner whose streams re-check every 7 ms, and a switch that makes the install refuse an organization.
async function gated() {
  const owner = await ownerContext();
  // The hook is there from the start: a stream opened while allowed must see it change its answer.
  const refusal = { key: "organization.refused", link: LINK };
  let lift = refusing(owner.db, "org_none", refusal);
  const context = { ...owner, organizationRecheckMs: RECHECK_MS };
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const refuse = (organizationId: string) => {
    lift();
    lift = refusing(owner.db, organizationId, refusal);
  };
  return { owner, context, signal: abort.signal, refuse };
}

const forbidden = (organizationId: string) => ({ code: "FORBIDDEN", data: { key: "organization.refused", link: LINK, organizationId } });

// How long an idle stream may take to end: a few re-checks, far below what an event-driven end would need.
const soon = <T>(next: Promise<T>) => Promise.race([next, new Promise((_, reject) => setTimeout(() => reject(new Error("still open")), 2_000))]);

test("an idle questions.stream ends with the refusal once its organization is refused, and leaves no listener", async () => {
  const { owner, context, signal, refuse } = await gated();
  const stream = await call(router.questions.stream, undefined, { context, signal });
  expect((await stream.next()).value).toEqual({ count: 0 });
  refuse(owner.organizationId);
  await expect(soon(stream.next())).rejects.toMatchObject(forbidden(owner.organizationId));
  expect(owner.engine.questionChanges.size).toBe(0);
});

test("an idle rows.stream ends with the refusal once its organization is refused, and leaves no listener", async () => {
  const { owner, context, signal, refuse } = await gated();
  const table = await call(router.tables.create, { name: "Projects" }, { context: owner });
  const stream = await call(router.rows.stream, { tableIds: [table.id] }, { context, signal });
  const first = stream.next();
  const row = await call(router.rows.create, { tableId: table.id }, { context: owner });
  expect((await first).value).toEqual({ type: "rows", tableId: table.id, rowIds: [row.id] });
  refuse(owner.organizationId);
  await expect(soon(stream.next())).rejects.toMatchObject(forbidden(owner.organizationId));
  expect((owner.dataEvents as unknown as { publisher: { size: number } }).publisher.size).toBe(0);
});

test("an idle runs.stream ends with the refusal once its organization is refused, and leaves no listener", async () => {
  const { owner, context, signal, refuse } = await gated();
  const { runId } = await jobIdentity(owner);
  const stream = await call(router.runs.stream, { runId }, { context, signal });
  expect((await stream.next()).value).toMatchObject({ type: "snapshot", run: { id: runId } });
  refuse(owner.organizationId);
  await expect(soon(stream.next())).rejects.toMatchObject(forbidden(owner.organizationId));
  expect(owner.engine.events.size).toBe(0);
});

test("a stream of a refused organization is refused on its first read", async () => {
  const { owner, context, signal, refuse } = await gated();
  const { runId } = await jobIdentity(owner);
  refuse(owner.organizationId);
  await expect((async () => (await call(router.runs.stream, { runId }, { context, signal })).next())()).rejects.toMatchObject(forbidden(owner.organizationId));
});

test("while the install refuses another organization, a stream keeps streaming past its re-checks", async () => {
  const { owner, context, signal, refuse } = await gated();
  refuse("org_other");
  const stream = await call(router.questions.stream, undefined, { context, signal });
  expect((await stream.next()).value).toEqual({ count: 0 });
  const next = stream.next();
  await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 5));
  owner.engine.questionChanged(owner.workspaceId);
  expect((await next).value).toEqual({ count: 0 });
});

test("someone outside a refused organization still gets NOT_FOUND for its run's stream", async () => {
  const { owner, signal, refuse } = await gated();
  const { runId } = await jobIdentity(owner);
  const outsider = await personContext(owner, "outsider", "member");
  await owner.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "outsider"));
  await owner.db.delete(organizationMembers).where(eq(organizationMembers.userId, "outsider"));
  refuse(owner.organizationId);
  const opened = (async () => (await call(router.runs.stream, { runId }, { context: { ...outsider, organizationRecheckMs: RECHECK_MS }, signal })).next())();
  await expect(opened).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(opened).rejects.not.toHaveProperty("data.link");
});

test("someone removed while their stream is idle doesn't get the refusal", async () => {
  const { owner, signal, refuse } = await gated();
  const member = await personContext(owner, "leaver", "member");
  const stream = await call(router.questions.stream, undefined, { context: { ...member, organizationRecheckMs: RECHECK_MS }, signal });
  expect((await stream.next()).value).toEqual({ count: 0 });
  await owner.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "leaver"));
  refuse(owner.organizationId);
  const ended = soon(stream.next());
  await expect(ended).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(ended).rejects.not.toHaveProperty("data.link");
});

test("with no refusal on the install, a stream starts no re-check", async () => {
  const owner = await ownerContext();
  const timers = vi.spyOn(globalThis, "setTimeout");
  onTestFinished(() => timers.mockRestore());
  const abort = new AbortController();
  const stream = await call(router.questions.stream, undefined, { context: { ...owner, organizationRecheckMs: RECHECK_MS }, signal: abort.signal });
  expect((await stream.next()).value).toEqual({ count: 0 });
  const next = stream.next();
  owner.engine.questionChanged(owner.workspaceId);
  expect((await next).value).toEqual({ count: 0 });
  expect(timers.mock.calls.some(([, ms]) => ms === RECHECK_MS)).toBe(false);
  abort.abort();
  await stream.return?.(undefined);
});
