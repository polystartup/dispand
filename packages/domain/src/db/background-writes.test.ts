import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { ensureAssistant, ensureAssistants } from "../agents/builtin.ts";
import { syncPlatformSkills } from "../assistant/skill.ts";
import { sweepAudit } from "../audit/sweep.ts";
import { sweepAttachments } from "../data/files.ts";
import { Engine } from "../engine/engine.ts";
import type { HarnessAdapter } from "../engine/harness.ts";
import { Scheduler } from "../engine/scheduler.ts";
import { PushSender, type Send } from "../push/sender.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, jobIdentity, ownerContext, recordScopes } from "../runners/test-support.ts";
import { secretAad } from "../secrets.ts";
import { resealToolHeaders } from "../tools/reseal.ts";
import { agents, attachments, audit, questions, runs, stepRuns, tools, triggers, workspaces } from "./schema.ts";
import { inScope, setTenancy, shared, SYSTEM, type Tenancy } from "./scope.ts";

// The app's startup and background work spans every workspace. Each job lists its workspaces under
// SYSTEM, reading only, and writes through `eachScope` in each workspace's scope. Under a tenancy
// that splits work by workspace (as a database adapter whose SYSTEM can only read does), none of
// it may write under SYSTEM.

class FakeAdapter implements HarnessAdapter {
  async start() {
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop() {
    return true;
  }
}

/** Each listed workspace in its own scope; a run's stored work in its run's workspace. */
const splitting: Tenancy = {
  async each(db, scopes, work) {
    for (const scope of await scopes(db)) await inScope(scope, work);
  },
  async forRun(db, runId, work) {
    const [run] = await inScope(SYSTEM, () => db.select({ organizationId: workspaces.organizationId, workspaceId: workspaces.id }).from(runs)
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId)).where(eq(runs.id, runId)));
    return run ? inScope(run, work) : work();
  },
};

const DAY = 86_400_000;

/** Startup's steps, one tick, one pass of each sweep and one push flush, under `tenancy`, on a recorder over two workspaces. */
async function background(tenancy: Tenancy) {
  const base = await ownerContext();
  const a = { organizationId: base.organizationId, workspaceId: base.workspaceId };
  const b = { organizationId: base.organizationId, workspaceId: "ws_b" };
  const now = new Date();

  // A: a running Job (recover goes on with it), a pending question with a device to push it to, a
  // header sealed the old way, and a held file past a day.
  const { runId } = await jobIdentity(base);
  const [step] = await base.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  // Its step was held while its root was paused, and the root went on before the process could hand it back: recover wakes it.
  await base.db.update(stepRuns).set({ working: false, pendingAction: { kind: "resume" } }).where(eq(stepRuns.id, step!.id));
  await call(router.push.subscribe, { endpoint: "https://push.example.com/phone", keys: { p256dh: "k", auth: "a" }, language: "en" }, { context: base });
  await new Promise((resolve) => setTimeout(resolve, 3));
  await base.db.insert(questions).values({ id: "q_bg", ownerId: base.ownerId, addresseeId: base.ownerId, runId, stepRunId: step!.id, placement: "notifications", kind: "question", status: "pending",
    payload: { kind: "choice", questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A" }] }] } });
  await base.db.insert(tools).values({ id: "tool_legacy", workspaceId: a.workspaceId, ownerId: base.ownerId, name: "Mail", kind: "http", url: "https://example.com/mcp", transport: "streamable-http",
    headersSealed: { authorization: base.secrets.seal("Bearer x", secretAad("tools", "tool_legacy", "header:authorization")) } } as never);
  await base.db.insert(attachments).values({ id: "att_held", workspaceId: a.workspaceId, ownerId: base.ownerId, name: "a.png", mime: "image/png", size: 1, image: true, createdAt: new Date(now.getTime() - 2 * DAY) });
  await mkdir(join(base.filesDir, base.ownerId), { recursive: true });
  await writeFile(join(base.filesDir, base.ownerId, "att_held"), "x");

  // B: an agent with a schedule trigger due, and an Audit row past the retention.
  const { runnerId } = await runnerWithClis(base);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: base });
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context: base });
  // The owner's Assistant, as an earlier version left it: startup gives it what this one adds.
  await ensureAssistant(base.db, base.ownerId, harness.id, base.workspaceId);
  await base.db.delete(triggers).where(eq(triggers.builtIn, "review"));
  await base.db.insert(workspaces).values({ id: b.workspaceId, organizationId: b.organizationId });
  await base.db.update(agents).set({ workspaceId: b.workspaceId }).where(eq(agents.id, agent.id));
  const past = new Date(now.getTime() - 3_600_000);
  await base.db.insert(triggers).values({ id: "trigger_due", ownerId: base.ownerId, agentId: agent.id, kind: "schedule", name: "Daily", instructions: "Review.",
    config: { kind: "schedule", cron: "* * * * *", timezone: "UTC" }, enabled: true, nextFireAt: past, lastCheckedAt: past } as never);
  await base.db.insert(audit).values({ id: "audit_old", workspaceId: b.workspaceId, ownerId: base.ownerId, at: new Date(now.getTime() - 400 * DAY), actor: { kind: "person", userId: base.ownerId } as never,
    action: "job.started" as never, resourceType: "job" as never, result: "ok" as never, details: {} });

  const recorder = await recordScopes(base.db);
  setTenancy(recorder.db, tenancy);
  onTestFinished(() => setTenancy(recorder.db, shared));
  const engine = new Engine(recorder.db, new FakeAdapter());
  onTestFinished(() => engine.stop());
  const send = vi.fn<Send>(async () => undefined);
  const sender = new PushSender(recorder.db, engine, base.secrets, { subject: "mailto:push@example.com", send });
  onTestFinished(() => sender.stop());

  // `startApp`'s steps, then one tick, one pass of each sweep and one push flush, all started under SYSTEM.
  const isWrite = (sql: string) => /^\s*(insert|update|delete)\b/i.test(sql);
  const steps: [string, () => Promise<unknown>][] = [
    ["platform skills", () => syncPlatformSkills(recorder.db)],
    ["Assistants", () => ensureAssistants(recorder.db)],
    ["header reseal", () => resealToolHeaders(recorder.db, base.secrets)],
    ["recover", () => engine.recover()],
    ["scheduler tick", () => new Scheduler(recorder.db, engine, { now: () => now }).tick()],
    ["attachment sweep", () => sweepAttachments(recorder.db, base.filesDir, now)],
    ["audit sweep", () => sweepAudit(recorder.db, now)],
    ["push flush", () => sender.flush()],
  ];
  /** Which steps wrote nothing: each one must, so the check covers its writes. */
  const idle: string[] = [];
  // `startApp`'s steps, then one tick, one pass of each sweep and one push flush, all started under SYSTEM.
  await inScope(SYSTEM, async () => {
    for (const [name, step] of steps) {
      const before = recorder.statements.length;
      await step();
      if (!recorder.statements.slice(before).some((st) => isWrite(st.sql))) idle.push(name);
    }
  });
  await engine.stop();
  const writes = recorder.statements.filter((s) => isWrite(s.sql));
  return { a, b, writes, send, idle };
}

test("startup, a scheduler tick, the attachment and audit sweeps and a push flush write nothing under SYSTEM", async () => {
  const { a, b, writes, send, idle } = await background(splitting);
  expect(idle).toEqual([]);
  expect(writes.filter((s) => s.scope === SYSTEM).map((s) => s.sql)).toEqual([]);
  expect(new Set(writes.map((s) => (s.scope === SYSTEM ? "SYSTEM" : s.scope.workspaceId)))).toEqual(new Set([a.workspaceId, b.workspaceId]));
  // Each job did write: the work ran, not only its listing.
  const wrote = (pattern: RegExp) => writes.some((s) => pattern.test(s.sql));
  for (const pattern of [/^update "tools"/, /^delete from "attachments"/, /^delete from "audit"/, /^insert into "push_deliveries"/, /^update "triggers"/]) expect(wrote(pattern), String(pattern)).toBe(true);
  expect(send).toHaveBeenCalled();
});

test("on a single-tenant database the same work writes under SYSTEM, as is: the check above can tell", async () => {
  const { writes } = await background(shared);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((s) => s.scope === SYSTEM)).toBe(true);
});
