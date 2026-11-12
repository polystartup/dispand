import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { ChatItem } from "../cloud/model-client.ts";
import { fakeModel, say, use, type Script } from "../cloud/test-model.ts";
import { runs } from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { Bundle, TableScope } from "./bundles.ts";
import { callPlatformTool, type JobIdentity } from "./call.ts";
import { platformToolCaller } from "./cloud.ts";

// What the Assistant reads to answer questions about the workspace: its harnesses, its Jobs and
// their transcripts, through `configure`.

const KEY = "sk-sentinel-never-shown";

/**
 * A cloud harness (with a key), a runner harness, the Assistant on the cloud one, and an engine
 * whose cloud sessions follow `script`.
 */
async function setup(script: Script[]) {
  const base = await ownerContext();
  const model = fakeModel(...script);
  const engine = createEngine(base.db, base.hub, base.secrets, base.dataEvents, { tools: platformToolCaller(() => context), client: model.client });
  onTestFinished(() => engine.stop());
  const context = { ...base, engine };
  const cloud = await call(
    router.harnesses.create,
    { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: KEY, model: "m-large", systemPrompt: "" } as never,
    { context },
  );
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const cli = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const assistant = await call(router.agents.ensureAssistant, { harnessId: cloud.id }, { context });
  const until = (runId: string, status: string) =>
    vi.waitFor(async () => {
      const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
      if (run!.status !== status) throw new Error(`run is ${run!.status}`);
    });
  /** Sends the Assistant one message, in a new conversation, and waits for its model's `turns` calls. */
  const ask = async (text: string, turns: number) => {
    const { runId } = await call(router.jobs.start, { triggerId: assistant.triggerId }, { context });
    await engine.sendChat(runId, text);
    await vi.waitFor(() => expect(model.inputs).toHaveLength(turns));
    return runId;
  };
  return { context, model, cloud, cli, assistant, until, ask };
}

const toolResults = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { role: "tool" }> => i.role === "tool");

test("the Assistant lists both harnesses with their type, runner and model, and never a key or a base URL", async () => {
  const s = await setup([use("harnesses_limits", {}), say("You have two.")]);
  await s.ask("Which harnesses do I have?", 2);
  const [result] = toolResults(s.model.inputs[1]!.items);
  expect(result).toMatchObject({ isError: false });
  expect(JSON.parse(result!.result)).toEqual([
    { id: s.cloud.id, name: "API", type: "cloud", kind: "openai-compatible", model: "m-large", runner: null, maxWorking: 5, working: expect.any(Number), queued: 0 },
    { id: s.cli.id, name: "Claude", type: "cli", kind: "claude-code", model: null, runner: { name: "Workstation", connected: false }, maxWorking: 5, working: 0, queued: 0 },
  ]);
  expect(result!.result).not.toContain(KEY);
  expect(result!.result).not.toContain("llm.test");
});

test("which agents touch Matters, and when, is answered from agents_list, triggers_list and tables_list", async () => {
  const ids = { agentId: "" };
  const s = await setup([
    use("tables_list", {}),
    use("agents_list", {}),
    () => ({ toolCalls: [{ id: "t", name: "triggers_list", args: { agentId: ids.agentId } }] }),
    say("The Clerk works on Matters, every Monday."),
  ]);
  const matters = await call(router.tables.create, { name: "Matters" }, { context: s.context });
  const clerk = await call(router.agents.create, { name: "Clerk", harnessId: s.cli.id, systemPrompt: "", bundles: ["data"], dataTables: [matters.id] }, { context: s.context });
  ids.agentId = clerk.id;
  await call(router.triggers.create, { agentId: clerk.id, name: "Weekly", instructions: "Review the matters.", config: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Paris" } } as never, { context: s.context });
  await s.ask("Which agents touch Matters, and when?", 4);
  const results = toolResults(s.model.inputs[3]!.items);
  expect(results.map((r) => r.isError)).toEqual([false, false, false]);
  expect(results[0]!.result).toContain(matters.id);
  expect(results[1]!.result).toContain(clerk.id);
  expect(results[1]!.result).toContain(matters.id);
  expect(results[2]!.result).toContain("0 9 * * 1");
});

test("the Assistant lists an agent's Jobs and reads one's transcript", async () => {
  const ids = { agentId: "", runId: "" };
  const s = await setup([
    // The Clerk's Job.
    say("Ada is added."),
    // The Assistant's.
    () => ({ toolCalls: [{ id: "l", name: "jobs_list", args: { agentId: ids.agentId } }] }),
    () => ({ toolCalls: [{ id: "g", name: "jobs_get", args: { id: ids.runId } }] }),
    say("It added Ada."),
  ]);
  const clerk = await call(router.agents.create, { name: "Clerk", harnessId: s.cloud.id, systemPrompt: "" }, { context: s.context });
  const go = await call(router.triggers.create, { agentId: clerk.id, name: "Go", instructions: "Add the client Ada.", config: { kind: "manual", placement: "button" } }, { context: s.context });
  const { runId } = await call(router.jobs.start, { triggerId: go.id }, { context: s.context });
  await s.until(runId, "succeeded");
  Object.assign(ids, { agentId: clerk.id, runId });
  await s.ask("What did the clerk do?", 4);
  const [listed, read] = toolResults(s.model.inputs[3]!.items);
  expect(listed).toMatchObject({ isError: false });
  expect(JSON.parse(listed!.result)).toEqual([expect.objectContaining({ id: runId, agentId: clerk.id, triggerId: go.id, status: "succeeded", cause: { kind: "user", depth: 0 }, openQuestionIds: [] })]);
  expect(read).toMatchObject({ isError: false });
  const job = JSON.parse(read!.result);
  expect(job).toMatchObject({ id: runId, status: "succeeded", totalMessages: job.messages.length, questions: [] });
  expect(job.messages.map((m: { text: string }) => m.text)).toEqual(["Ada is added."]);
  // Its token, sealed or hashed, and its snapshot stay on the server.
  expect(Object.keys(job).sort()).toEqual(["agentId", "agentName", "cause", "createdAt", "error", "finishedAt", "id", "messages", "questions", "status", "totalMessages", "triggerId"]);
});

/** A Job still going (its runner is away) of an agent on the runner harness with `bundles` on `tables`. */
async function readerJob(s: Awaited<ReturnType<typeof setup>>, bundles: Bundle[], tables: TableScope) {
  const agent = await call(router.agents.create, { name: `Reader ${bundles.join(" ")}`, harnessId: s.cli.id, systemPrompt: "", bundles, dataTables: tables }, { context: s.context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Read.", config: { kind: "manual", placement: "button" } }, { context: s.context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: s.context });
  const job: JobIdentity = { runId, ownerId: s.context.ownerId, agentId: agent.id };
  return (name: string, input: unknown = {}) => callPlatformTool(s.context, job, name, input);
}

test("Jobs are read with configure only, and a transcript only by a Job on every table", async () => {
  const s = await setup([say("Done.")]);
  const clients = await call(router.tables.create, { name: "Clients" }, { context: s.context });
  const clerk = await call(router.agents.create, { name: "Clerk", harnessId: s.cloud.id, systemPrompt: "", bundles: ["data"], dataTables: [clients.id] }, { context: s.context });
  const go = await call(router.triggers.create, { agentId: clerk.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: s.context });
  const { runId } = await call(router.jobs.start, { triggerId: go.id }, { context: s.context });
  await s.until(runId, "succeeded");

  const data = await readerJob(s, ["data"], "all");
  for (const name of ["jobs_list", "jobs_get", "jobs_def", "workflows_list"]) {
    expect(await data(name, { id: runId, runId })).toEqual({ ok: false, error: `This agent may not use ${name}` });
  }
  // A transcript holds whatever its Job read, from any table: only a Job on every table reads it,
  // even one listing the Clerk's table, which lists the Job and no more.
  const within = await readerJob(s, ["data", "configure"], [clients.id]);
  expect(await within("jobs_list", { agentId: clerk.id })).toMatchObject({ ok: true, output: [{ id: runId }] });
  expect(await within("jobs_get", { id: runId })).toEqual({ ok: false, error: "Not found" });
  expect(await within("jobs_def", { runId })).toEqual({ ok: false, error: "Not found" });
  const all = await readerJob(s, ["configure"], "all");
  expect(await all("jobs_get", { id: runId })).toMatchObject({ ok: true, output: { id: runId } });
  expect(await all("jobs_def", { runId })).toMatchObject({ ok: true });
  // Once its table is deleted, its Job is still the whole workspace's to read.
  await call(router.tables.delete, { id: clients.id }, { context: s.context });
  expect(await within("jobs_get", { id: runId })).toEqual({ ok: false, error: "Not found" });
  // An id that is no Job is not found.
  expect(await all("jobs_get", { id: "run_nobody" })).toEqual({ ok: false, error: "Not found" });
  // A Job lists itself, still going.
  expect(await within("jobs_list", { status: "running" })).toMatchObject({ ok: true, output: expect.arrayContaining([expect.objectContaining({ status: "running" })]) });
  expect(await within("workflows_list")).toEqual({ ok: true, output: [] });
  // A poll item's id is what its tool read (a subject line): a Job lists the poll, not the item.
  await s.context.db.update(runs).set({ cause: { kind: "poll", triggerId: go.id, itemId: "Re: the confidential deal", depth: 0 } }).where(eq(runs.id, runId));
  const polled = await all("jobs_list", { agentId: clerk.id });
  expect(polled).toMatchObject({ ok: true, output: [{ id: runId, cause: { kind: "poll", triggerId: go.id, depth: 0 } }] });
  expect(JSON.stringify(polled)).not.toContain("confidential");
});

test("a Job of a deleted agent is still read through jobs_list and jobs_get, its agent named as deleted", async () => {
  const s = await setup([say("Filed.")]);
  const clerk = await call(router.agents.create, { name: "Order drafter", harnessId: s.cloud.id, systemPrompt: "" }, { context: s.context });
  const go = await call(router.triggers.create, { agentId: clerk.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: s.context });
  const { runId } = await call(router.jobs.start, { triggerId: go.id }, { context: s.context });
  await s.until(runId, "succeeded");
  await call(router.agents.delete, { id: clerk.id }, { context: s.context });

  const all = await readerJob(s, ["configure"], "all");
  const listed = await all("jobs_list", { status: "succeeded" });
  expect(listed).toMatchObject({ ok: true, output: [{ id: runId, agentId: null, agentName: "Order drafter (Deleted)" }] });
  expect(await all("jobs_get", { id: runId })).toMatchObject({
    ok: true,
    output: { id: runId, agentId: null, agentName: "Order drafter (Deleted)", messages: [{ text: "Filed." }] },
  });
  expect(await all("jobs_def", { runId })).toMatchObject({ ok: true });
});
