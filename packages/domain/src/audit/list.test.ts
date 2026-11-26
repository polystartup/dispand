import { call, ORPCError } from "@orpc/server";
import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { user, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, emptyContext, ownerContext } from "../runners/test-support.ts";
import { AUDIT_PAGE, listAudit } from "./list.ts";
import { recordAudit } from "./record.ts";

test("audit.list pages newest first, and filters by Job and by action family", async () => {
  const context = await ownerContext();
  const { ownerId } = context;
  const write = (jobId: string, action: "job.created" | "job.started" | "job.finished", n = 1) =>
    Promise.all(Array.from({ length: n }, () => recordAudit(context.db, { workspaceId: context.workspaceId, ownerId, actor: { type: "job", runId: jobId }, agentId: "agent_1", jobId, action, resource: { type: "job", id: jobId } })));
  await write("run_1", "job.created", 60);
  await write("run_2", "job.started", 3);
  await write("run_2", "job.finished");

  const first = await call(router.audit.list, {}, { context });
  expect(first.rows).toHaveLength(AUDIT_PAGE);
  expect(first.next).toBeTruthy();
  const second = await call(router.audit.list, { cursor: first.next! }, { context });
  expect(second.rows).toHaveLength(64 - AUDIT_PAGE);
  expect(second.next).toBeNull();
  const all = [...first.rows, ...second.rows];
  // Every row once, newest first.
  expect(new Set(all.map((r) => r.id)).size).toBe(64);
  const keys = all.map((r) => `${r.at}|${r.id}`);
  expect(keys).toEqual([...keys].sort().reverse());
  expect(all[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

  expect((await call(router.audit.list, { jobId: "run_2" }, { context })).rows.map((r) => r.action).sort()).toEqual(["job.finished", "job.started", "job.started", "job.started"]);
  expect((await call(router.audit.list, { jobId: "run_2", action: "job.started" }, { context })).rows).toHaveLength(3);
  expect((await call(router.audit.list, { action: "job" }, { context })).rows).toHaveLength(AUDIT_PAGE);
  expect((await call(router.audit.list, { action: "question" }, { context })).rows).toEqual([]);
  expect((await call(router.audit.list, { actorType: "user" }, { context })).rows).toEqual([]);
  expect((await call(router.audit.list, { actorType: "job", agentId: "agent_1", resourceType: "job", resourceId: "run_2", result: "ok" }, { context })).rows).toHaveLength(4);
  expect((await call(router.audit.list, { to: new Date(0).toISOString() }, { context })).rows).toEqual([]);
});

test("another workspace's rows never appear, a member's do, and a forged cursor is a bad request", async () => {
  const context = await ownerContext();
  const { db, organizationId, workspaceId } = context;
  await db.insert(user).values({ id: "user_other", name: "Bob", email: "bob@example.com" });
  await db.insert(workspaces).values({ id: "ws_b", organizationId });
  await recordAudit(db, { workspaceId: "ws_b", ownerId: context.ownerId, actor: { type: "scheduler" }, action: "job.skipped", resource: { type: "trigger", id: "trg_b" } });
  await recordAudit(db, { workspaceId, ownerId: "user_other", actor: { type: "user", userId: "user_other" }, action: "profile.updated", resource: { type: "user", id: "user_other" } });
  // The procedure serves a one-workspace install for now: B's rows are read the way a pass of A would.
  const listed = await listAudit(db, context.ownerId, workspaceId, {});
  expect(listed.rows.map((r) => [r.resourceId, r.actorName, r.byYou])).toEqual([["user_other", "Bob", false]]);
  expect((await listAudit(db, context.ownerId, "ws_b", {})).rows.map((r) => r.resourceId)).toEqual(["trg_b"]);
  await db.delete(workspaces).where(eq(workspaces.id, "ws_b"));
  expect((await call(router.audit.list, {}, { context })).rows.map((r) => r.resourceId)).toEqual(["user_other"]);
  const forged = Buffer.from(JSON.stringify({ at: "now()); drop table audit; --", id: "x" })).toString("base64url");
  await expect(call(router.audit.list, { cursor: forged }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.audit.list, { action: "job.deleted" as never }, { context })).rejects.toBeInstanceOf(ORPCError);
});

test("deleting a person keeps their rows, with no name", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Bob", email: "bob@example.com" });
  await recordAudit(context.db, { workspaceId: context.workspaceId, ownerId: "user_other", actor: { type: "user", userId: "user_other" }, action: "profile.updated", resource: { type: "user", id: "user_other" } });
  await context.db.delete(user).where(eq(user.id, "user_other"));
  const [row] = (await call(router.audit.list, {}, { context })).rows;
  expect(row).toMatchObject({ ownerId: null, actor: { type: "user", userId: "user_other" }, actorName: null, byYou: false });
});

test("audit.list and audit.traceUrl need the owner's session; the trace URL is the server's setting", async () => {
  const anonymous = await emptyContext();
  await expect(call(router.audit.list, {}, { context: anonymous })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const context = await ownerContext();
  expect(await call(router.audit.traceUrl, undefined, { context })).toEqual({ traceUrl: null });
  expect(await call(router.audit.traceUrl, undefined, { context: { ...context, traceUrl: "https://traces.example.com/{traceId}" } })).toEqual({
    traceUrl: "https://traces.example.com/{traceId}",
  });
});

test("rows that share their time list in the order they were written", { tags: ["postgres-468"] }, async () => {
  const context = await ownerContext();
  const { ownerId } = context;
  const write = (db: Parameters<typeof recordAudit>[0], item: number) =>
    recordAudit(db, { workspaceId: context.workspaceId, ownerId, actor: { type: "job", runId: "run_1" }, agentId: "agent_1", jobId: "run_1", action: "platform.call", resource: { type: "row" }, details: { item } });
  // In one transaction, as one change records several rows: every row has the same `at`. Started
  // together, so each row's id is made within the same millisecond as the next, as on a fast machine.
  await context.db.transaction((tx) => Promise.all(Array.from({ length: 50 }, (_, item) => write(tx, item))));
  await Promise.all(Array.from({ length: 50 }, (_, item) => write(context.db, 50 + item)));
  const first = await call(router.audit.list, { jobId: "run_1" }, { context });
  const second = await call(router.audit.list, { jobId: "run_1", cursor: first.next! }, { context });
  expect([...first.rows, ...second.rows].map((r) => r.details.item)).toEqual(Array.from({ length: 100 }, (_, i) => 99 - i));
});

test("a row of the built-in agent says so, so the page shows its label rather than the stored name", async () => {
  const context = await ownerContext();
  const { ownerId } = context;
  const { runnerId } = await runnerWithClis(context);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const { agentId } = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context });
  await recordAudit(context.db, { workspaceId: context.workspaceId, ownerId, actor: { type: "job", runId: "run_1" }, agentId, jobId: "run_1", action: "job.started", resource: { type: "job", id: "run_1" } });
  const [row] = (await call(router.audit.list, {}, { context })).rows;
  expect(row).toMatchObject({ agentName: "Assistant", agentBuiltIn: "assistant" });
});
