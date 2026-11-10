import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { questions, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { canonical, takeApproval } from "./approvals.ts";
import type { JobIdentity } from "./call.ts";

const TOOL = "mcp__job_tools__github_create_issue";

/** A Job still going, with a way to record the runner's permission question and the owner's answer. */
async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const job = async (): Promise<JobIdentity & { ask: (toolName: string, input: unknown, decision?: "allow" | "allow-always" | "deny" | null) => Promise<string> }> => {
    const agent = await call(router.agents.create, { name: `Clerk ${Math.random()}`, harnessId: harness.id, systemPrompt: "" }, { context });
    const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    let n = 0;
    return {
      runId,
      ownerId: context.ownerId,
      agentId: agent.id,
      /** The session asks permission for a call; the owner answers (null: not yet). */
      async ask(toolName, input, decision = "allow") {
        const id = `q_${runId}_${++n}`;
        await context.db.insert(questions).values({
          id,
          ownerId: context.ownerId,
          runId,
          stepRunId: step!.id,
          sessionId: step!.sessionId!,
          runnerQuestionId: `rq_${n}`,
          placement: "notifications",
          kind: "approval",
          payload: { kind: "permission", toolName, input: input as never, canAlwaysAllow: false },
          status: decision ? "answered" : "pending",
          answer: decision ? { kind: "permission", decision } : null,
          answeredAt: decision ? new Date() : null,
        });
        return id;
      },
    };
  };
  return { context, job };
}

test("an allowed approval is taken once", async () => {
  const { context, job } = await setup();
  const j = await job();
  const id = await j.ask(TOOL, { title: "Bug" });
  expect(await takeApproval(context.db, j, TOOL, { title: "Bug" })).toBe(true);
  const [row] = await context.db.select().from(questions).where(eq(questions.id, id));
  expect(row!.consumedAt).toBeInstanceOf(Date);
  expect(await takeApproval(context.db, j, TOOL, { title: "Bug" })).toBe(false);
  // Asked and allowed again: one more call.
  await j.ask(TOOL, { title: "Bug" });
  expect(await takeApproval(context.db, j, TOOL, { title: "Bug" })).toBe(true);
  expect(await takeApproval(context.db, j, TOOL, { title: "Bug" })).toBe(false);
});

test("key order doesn't matter, content does", async () => {
  const { context, job } = await setup();
  const j = await job();
  await j.ask(TOOL, { title: "Bug", labels: ["a", "b"], meta: { x: 1, y: null } });
  for (const changed of [
    { title: "Bug" },
    { title: "Bug", labels: ["b", "a"], meta: { x: 1, y: null } },
    { title: "Bug", labels: ["a", "b"], meta: { x: 1, y: null }, extra: true },
    { title: "bug", labels: ["a", "b"], meta: { x: 1, y: null } },
    { title: "Bug", labels: ["a", "b"], meta: { x: "1", y: null } },
  ]) {
    expect(await takeApproval(context.db, j, TOOL, changed)).toBe(false);
  }
  expect(await takeApproval(context.db, j, TOOL, { meta: { y: null, x: 1 }, labels: ["a", "b"], title: "Bug" })).toBe(true);
  expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonical({ a: [{ c: 2, d: 1 }], b: 1 }));
  expect(canonical({ a: 1 })).not.toBe(canonical({ a: "1" }));
});

test("two concurrent takes get one", async () => {
  const { context, job } = await setup();
  const j = await job();
  await j.ask(TOOL, {});
  const taken = await Promise.all([takeApproval(context.db, j, TOOL, {}), takeApproval(context.db, j, TOOL, {}), takeApproval(context.db, j, TOOL, {})]);
  expect(taken.filter(Boolean)).toHaveLength(1);
});

test("a denied, pending or other Job's approval, or one for another tool, is never taken", async () => {
  const { context, job } = await setup();
  const j = await job();
  const other = await job();
  await j.ask(TOOL, { n: 1 }, "deny");
  await j.ask(TOOL, { n: 2 }, null);
  await other.ask(TOOL, { n: 3 });
  await j.ask("mcp__job__rows_create", { n: 4 });
  await j.ask("Bash", { n: 5 });
  for (const n of [1, 2, 3, 4, 5]) expect(await takeApproval(context.db, j, TOOL, { n })).toBe(false);
  // An identity that doesn't match its run takes nothing.
  await j.ask(TOOL, { n: 6 });
  expect(await takeApproval(context.db, { ...j, ownerId: "user_nobody" }, TOOL, { n: 6 })).toBe(false);
  expect(await takeApproval(context.db, { ...j, agentId: other.agentId }, TOOL, { n: 6 })).toBe(false);
  expect(await takeApproval(context.db, j, TOOL, { n: 6 })).toBe(true);
});

test("an approval of a Job that is over is not taken, and always-allow is one call like allow", async () => {
  const { context, job } = await setup();
  const j = await job();
  await j.ask(TOOL, { n: 1 }, "allow-always");
  expect(await takeApproval(context.db, j, TOOL, { n: 1 })).toBe(true);
  expect(await takeApproval(context.db, j, TOOL, { n: 1 })).toBe(false);
  await j.ask(TOOL, { n: 2 });
  await context.engine.stopRun(j.runId);
  expect(await takeApproval(context.db, j, TOOL, { n: 2 })).toBe(false);
});
