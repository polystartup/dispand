import { PROTOCOL_VERSION } from "@dispand/runner-protocol";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../db/client.ts";
import { agents, polls, runners, triggers, type PollStatus } from "../db/schema.ts";
import { STALE_TICK_MS } from "../engine/scheduler.ts";
import { router } from "../rpc/router.ts";
import { harnessIn, ownerContext, personContext, runnerWithClis, secondWorkspace } from "../runners/test-support.ts";

const config = { kind: "poll" as const, toolId: "tool_x", action: "list", arguments: {}, itemsPath: "", idPath: "id", interval: 300 };

/** A poll trigger of a new agent of `workspaceId`, and its polls (oldest first), straight in the rows. */
async function pollTrigger(
  db: Db,
  workspaceId: string,
  id: string,
  list: [PollStatus, string?][],
  agent: { ownerId: string; builtIn?: "assistant"; enabled?: boolean },
) {
  const { harnessId } = await harnessIn(db, workspaceId, agent.ownerId, `harness_${id}`);
  await db
    .insert(agents)
    .values({ id: `agent_${id}`, workspaceId, ownerId: agent.ownerId, name: `Agent ${id}`, harnessId, systemPrompt: "", builtIn: agent.builtIn });
  await db.insert(triggers).values({ id, agentId: `agent_${id}`, ownerId: agent.ownerId, kind: "poll", name: `Trigger ${id}`, config, enabled: agent.enabled ?? true });
  for (const [i, [status, message]] of list.entries())
    await db.insert(polls).values({ id: `${id}_poll_${i}`, triggerId: id, ownerId: agent.ownerId, at: new Date(Date.UTC(2026, 10, 1, 10, i)), status, message });
}

test("system › a workspace's managers read it, its members don't", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "member");
  const mia = await personContext(owner, "mia", "manager");
  await expect(call(router.system.status, undefined, { context: pat })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(router.system.status, undefined, { context: mia })).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  await expect(call(router.system.status, undefined, { context: owner })).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
});

test("system › the workspace's runners, each with the protocol it last connected with, against the server's", async () => {
  const owner = await ownerContext();
  const { a, b } = await secondWorkspace(owner);
  const never = await runnerWithClis(a, "Never connected");
  const old = await runnerWithClis(a, "Old");
  await a.db.update(runners).set({ protocolVersion: PROTOCOL_VERSION - 1 }).where(eq(runners.id, old.runnerId));
  const revoked = await runnerWithClis(a, "Revoked");
  await a.db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, revoked.runnerId));
  await runnerWithClis(b, "Elsewhere");
  const status = await call(router.system.status, undefined, { context: a });
  expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(status.runners).toEqual([
    { id: never.runnerId, name: "Never connected", status: "offline", protocolVersion: null, lastSeenAt: expect.any(Date) },
    { id: old.runnerId, name: "Old", status: "outdated", protocolVersion: PROTOCOL_VERSION - 1, lastSeenAt: expect.any(Date) },
  ]);
  expect((await call(router.system.status, undefined, { context: b })).runners.map((r) => r.name)).toEqual(["Elsewhere"]);
});

test("system › the poll triggers whose latest poll that ended failed, newest first, among those the person sees", async () => {
  const owner = await ownerContext();
  const { a, b } = await secondWorkspace(owner);
  const pat = await personContext(owner, "pat", "member");
  const me = { ownerId: owner.ownerId };
  await pollTrigger(a.db, a.workspaceId, "failing", [["polled"], ["failed", "first"], ["failed", "second"]], me);
  await pollTrigger(a.db, a.workspaceId, "recovered", [["failed", "old"], ["polled"]], me);
  // A poll under way says nothing yet: the one before it is the latest.
  await pollTrigger(a.db, a.workspaceId, "calling", [["failed", "before the call"], ["calling"]], me);
  await pollTrigger(a.db, a.workspaceId, "skipped", [["skipped", "needs a sign-in"]], me);
  await pollTrigger(a.db, a.workspaceId, "off", [["failed", "off"]], { ...me, enabled: false });
  // Another person's Assistant stays theirs, even to a manager.
  await pollTrigger(a.db, a.workspaceId, "pats", [["failed", "pat's"]], { ownerId: pat.ownerId, builtIn: "assistant" });
  await pollTrigger(b.db, b.workspaceId, "elsewhere", [["failed", "elsewhere"]], me);
  const { failingPolls } = await call(router.system.status, undefined, { context: a });
  expect(failingPolls).toEqual([
    { triggerId: "failing", triggerName: "Trigger failing", agentId: "agent_failing", agentName: "Agent failing", at: new Date(Date.UTC(2026, 10, 1, 10, 2)), message: "second" },
    { triggerId: "calling", triggerName: "Trigger calling", agentId: "agent_calling", agentName: "Agent calling", at: new Date(Date.UTC(2026, 10, 1, 10, 0)), message: "before the call" },
  ]);
  expect((await call(router.system.status, undefined, { context: b })).failingPolls.map((p) => p.triggerId)).toEqual(["elsewhere"]);
});

test("system › how long ago this process's scheduler ticked, stale past the health check's limit, or none without one", async () => {
  const owner = await ownerContext();
  const at = (since: number | undefined) => call(router.system.status, undefined, { context: { ...owner, scheduler: { sinceTick: () => since } } });
  expect((await call(router.system.status, undefined, { context: owner })).scheduler).toBeNull();
  expect((await at(undefined)).scheduler).toBeNull();
  expect((await at(12_000)).scheduler).toEqual({ sinceTickMs: 12_000, stale: false });
  expect((await at(STALE_TICK_MS + 1)).scheduler).toEqual({ sinceTickMs: STALE_TICK_MS + 1, stale: true });
});
