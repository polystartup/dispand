import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { organizationMembers, runs, user, workspaceMembers } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, personContext, refusing } from "../runners/test-support.ts";

type Owner = Awaited<ReturnType<typeof ownerContext>>;
type Reader = Awaited<ReturnType<typeof personContext>>;

const LINK = "/organization-settings";
const refusal = { key: "organization.refused", link: LINK };
const missing = { code: "NOT_FOUND", data: { key: "workflows.runNotFound" } };
const signedOut = { code: "UNAUTHORIZED", data: { key: "auth.signIn" } };
const refused = (organizationId: string) => ({ code: "FORBIDDEN", data: { ...refusal, organizationId } });

/**
 * A member's own run, streamed by them. The install may refuse organizations from the start, and
 * the idle re-check is an hour away: only the next event can end the stream.
 */
async function streaming(
  reading: (owner: Owner, reader: Reader) => Reader & { job?: { runId: string; ownerId: string; workspaceId: string; agentId: string } } = (_, reader) =>
    reader,
) {
  const owner = await ownerContext();
  const reader = await personContext(owner, "reader", "member");
  let lift = refusing(owner.db, "org_none", refusal);
  await owner.db.insert(runs).values({ id: "chat", workspaceId: owner.workspaceId, ownerId: "reader", source: "workflow", version: 1, status: "running" });
  const abort = new AbortController();
  const stream = await call(
    router.runs.stream,
    { runId: "chat" },
    { context: { ...reading(owner, reader), organizationRecheckMs: 3_600_000 }, signal: abort.signal },
  );
  onTestFinished(async () => {
    abort.abort();
    await stream.return?.(undefined);
  });
  const first = await stream.next();
  expect(first.value).toMatchObject({ type: "snapshot", run: { id: "chat" } });
  const { run } = first.value as unknown as { run: never };
  const event = () => owner.engine.events.publish("chat", { type: "run", run });
  // The stream delivers before the change: what ends it is the change, at the next event.
  event();
  expect((await stream.next()).value).toMatchObject({ type: "run" });
  const refuse = () => {
    lift();
    lift = refusing(owner.db, owner.organizationId, refusal);
  };
  const ends = async (changed: () => Promise<unknown>, error: object) => {
    await changed();
    event();
    const next = stream.next();
    await expect(next).rejects.toMatchObject(error);
    return next.catch((e: unknown) => e);
  };
  return { owner, reader, refuse, ends };
}

const unassign = (s: { owner: Owner }) => s.owner.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "reader"));

test("runs.stream ends at the next event once the person's organization membership is revoked", async () => {
  const s = await streaming();
  await s.ends(() => s.owner.db.delete(organizationMembers).where(eq(organizationMembers.userId, "reader")), missing);
});

test("runs.stream ends at the next event once the person's workspace assignment is removed", async () => {
  const s = await streaming();
  await s.ends(() => unassign(s), missing);
});

test("runs.stream ends at the next event once the person is deleted (archived)", async () => {
  const s = await streaming();
  await s.ends(() => s.owner.db.update(user).set({ archivedAt: new Date() }).where(eq(user.id, "reader")), missing);
});

test("runs.stream ends at the next event once its session signs out", async () => {
  const s = await streaming();
  await s.ends(() => s.reader.auth.api.signOut({ headers: s.reader.headers }), signedOut);
});

test("runs.stream ends at the next event, with the refusal, once the install refuses the organization", async () => {
  const s = await streaming();
  await s.ends(async () => s.refuse(), refused(s.owner.organizationId));
});

test("runs.stream ends at the next event once the person may no longer read the run", async () => {
  const s = await streaming();
  // Another person's run: no longer the reader's to see.
  await s.ends(() => s.owner.db.update(runs).set({ ownerId: s.owner.ownerId }).where(eq(runs.id, "chat")), missing);
});

// The checks before the refusal answer first; the run's own visibility only once admitted.
test("runs.stream: someone removed from a refused organization's workspace gets NOT_FOUND, not the refusal", async () => {
  const s = await streaming();
  const error = await s.ends(async () => {
    await unassign(s);
    s.refuse();
  }, missing);
  expect(error).not.toHaveProperty("data.link");
});

test("runs.stream: a member of a refused organization gets the refusal even for a run they may no longer read", async () => {
  const s = await streaming();
  await s.ends(async () => {
    await s.owner.db.update(runs).set({ ownerId: s.owner.ownerId }).where(eq(runs.id, "chat"));
    s.refuse();
  }, refused(s.owner.organizationId));
});

test("runs.stream: a run deleted in a refused organization answers NOT_FOUND, not the refusal", async () => {
  const s = await streaming();
  await s.ends(async () => {
    await s.owner.db.delete(runs).where(eq(runs.id, "chat"));
    s.refuse();
  }, missing);
});

test("a Job's runs.stream ends at the next event once its person's workspace assignment is removed", async () => {
  // The Job reads its person's run: no session to check, the same admission.
  const s = await streaming((owner, reader) => ({
    ...reader,
    headers: new Headers(),
    job: { runId: "chat", ownerId: "reader", workspaceId: owner.workspaceId, agentId: "worker" },
  }));
  await s.ends(
    () => s.owner.db.delete(workspaceMembers).where(and(eq(workspaceMembers.userId, "reader"), eq(workspaceMembers.workspaceId, s.owner.workspaceId))),
    missing,
  );
});
