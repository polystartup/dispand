import { call } from "@orpc/server";
import type { ServerToRunner } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { agents, runs, skills, stepRuns, tools, skillPackages, user } from "../db/schema.ts";
import { fakeModel, say, use } from "../cloud/test-model.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { CliHarnessAdapter } from "../engine/cli-harness.ts";
import { Engine } from "../engine/engine.ts";
import { sessionTooling } from "../engine/tooling.ts";
import { router } from "../rpc/router.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { ownerContext } from "../runners/test-support.ts";
import { readSkill } from "../skills/cloud.ts";
import { packageForRunner } from "../skills/runner-access.ts";

async function setup() {
  const base = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Runner" }, { context: base });
  const harness = await call(router.harnesses.create, { name: "CLI", kind: "claude-code", runnerId, permissionMode: "default" }, { context: base });
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: base });
  const pkg = await call(router.skills.create, { name: "tidy", description: "Tidy", instructions: "Read references/rules.md", files: [{ path: "references/rules.md", base64: Buffer.from("Trim cells").toString("base64") }], requiredToolIds: [] }, { context: base });
  const [skill] = await base.db.select().from(skills).where(eq(skills.packageId, pkg.packageId));
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_runner: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const engine = new Engine(base.db, new CliHarnessAdapter(base.db, hub as unknown as RunnerHub, base.secrets), undefined, undefined, undefined, base.secrets);
  onTestFinished(() => engine.stop());
  return { context: { ...base, engine }, runnerId, assistant, pkg, skill: skill!, sent, engine };
}

test("an explicit choice loads the package and its references only in this conversation", async () => {
  const s = await setup();
  const { runId } = await call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: s.skill.id }, { context: s.context });
  await vi.waitFor(() => expect(s.sent.some((m) => m.type === "session.start")).toBe(true));
  const start = s.sent.flatMap((m) => m.type === "session.start" ? [m.start] : [])[0]!;
  expect(start.skills).toContainEqual({ name: "tidy", packageId: s.pkg.packageId });
  expect((await packageForRunner(s.context.db, s.runnerId, s.pkg.packageId))?.files.some((f) => f.path === "tidy/references/rules.md")).toBe(true);
  expect((await readSkill(s.context.db, start.sessionId, { skill: "tidy", path: "references/rules.md" })).text).toBe("Trim cells");
  const permanent = await call(router.agents.get, { id: s.assistant.agentId }, { context: s.context });
  expect(permanent.skills.some((p) => p.packageId === s.pkg.packageId)).toBe(false);
  const [run] = await s.context.db.select().from(runs).where(eq(runs.id, runId));
  expect(run?.snapshot?.invokedSkills).toEqual([s.pkg.packageId]);
  await call(router.skills.delete, { packageId: s.pkg.packageId }, { context: s.context });
  expect((await sessionTooling(s.context.db, start.sessionId)).skills.some((p) => p.packageId === s.pkg.packageId)).toBe(false);
});

test("an idle conversation reloads with the selected package and keeps its original harness", async () => {
  const s = await setup();
  const runId = await s.engine.startJob(s.assistant.triggerId, s.context.ownerId);
  await vi.waitFor(() => expect(s.sent.some((m) => m.type === "session.start")).toBe(true));
  const start = s.sent.flatMap((m) => m.type === "session.start" ? [m.start] : [])[0]!;
  await s.engine.onHarnessEvent(start.sessionId, { type: "cli-session", cliSessionId: "cli_1" }, { runnerId: s.runnerId, seq: 1 });
  await s.engine.onHarnessEvent(start.sessionId, { type: "turn-end" }, { runnerId: s.runnerId, seq: 2 });
  const nextHarness = await call(router.harnesses.create, { name: "Other", kind: "codex", runnerId: s.runnerId, permissionMode: "default" }, { context: s.context });
  await s.context.db.update(agents).set({ harnessId: nextHarness.id }).where(eq(agents.id, s.assistant.agentId));
  await call(router.runs.sendChat, { runId, text: "/tidy:tidy these rows", skillId: s.skill.id }, { context: s.context });
  const [step] = await s.context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  expect(step?.harness?.kind).toBe("claude-code");
  expect(step?.resumeAfterSession?.sessionId).toBe(start.sessionId);
  await s.engine.onHarnessEvent(start.sessionId, { type: "session-ended" }, { runnerId: s.runnerId, seq: 3 });
  await vi.waitFor(() => expect(s.sent.filter((m) => m.type === "session.start")).toHaveLength(2));
  const resumed = s.sent.flatMap((m) => m.type === "session.start" ? [m.start] : [])[1]!;
  expect(resumed.prompt).toBe("/tidy:tidy these rows");
  expect(resumed.skills).toContainEqual({ packageId: s.pkg.packageId, name: "tidy" });
});

test("unknown choices and agent-originated choices are refused without creating a Job", async () => {
  const s = await setup();
  await expect(call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: "missing" }, { context: s.context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await s.context.db.select().from(runs)).toEqual([]);
  await expect(call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: s.skill.id }, { context: { ...s.context, job: { ownerId: s.context.ownerId, runId: "job", agentId: s.assistant.agentId } } })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("selected required tools still ask, and incompatible runner tools are refused", async () => {
  const s = await setup();
  await s.context.db.insert(tools).values({ id: "tool_required", ownerId: s.context.ownerId, name: "Required", kind: "http", url: "https://tools.test/mcp", transport: "streamable-http", actions: [{ name: "write", description: "Write", inputSchema: {} }] });
  const pkg = await call(router.skills.create, { name: "needs-tool", description: "Needs tool", instructions: "Use write", requiredToolIds: ["tool_required", "tool_required"] }, { context: s.context });
  const [skill] = await s.context.db.select().from(skills).where(eq(skills.packageId, pkg.packageId));
  const { runId } = await call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: skill!.id }, { context: s.context });
  const [step] = await s.context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  const tooling = await sessionTooling(s.context.db, step!.sessionId!);
  expect(tooling.httpTools).toEqual([expect.objectContaining({ id: "tool_required", unasked: [] })]);
  const other = await call(router.runners.create, { name: "Other" }, { context: s.context });
  await s.context.db.insert(tools).values({ id: "tool_elsewhere", ownerId: s.context.ownerId, name: "Elsewhere", kind: "runner", runnerId: other.runnerId, runnerTool: "tool" });
  const incompatible = await call(router.skills.create, { name: "elsewhere", description: "Other", instructions: "Other", requiredToolIds: ["tool_elsewhere"] }, { context: s.context });
  const [bad] = await s.context.db.select().from(skills).where(eq(skills.packageId, incompatible.packageId));
  await expect(call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: bad!.id }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("foreign skill IDs cannot be loaded or listed", async () => {
  const s = await setup();
  await s.context.db.insert(user).values({ id: "other", name: "Other", email: "other@example.test" });
  await s.context.db.insert(skillPackages).values({ id: "foreign_pkg", ownerId: "other", name: "foreign", description: "Foreign", requiredToolIds: [] });
  await s.context.db.insert(skills).values({ id: "foreign_skill", packageId: "foreign_pkg", name: "foreign", description: "Foreign" });
  await expect(call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: "foreign_skill" }, { context: s.context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  vi.spyOn(s.context.hub, "commands").mockRejectedValue(new Error("offline"));
  const catalog = await call(router.assistantCommands, { agentId: s.assistant.agentId }, { context: s.context });
  expect(catalog.entries.some((e) => e.name.includes("foreign"))).toBe(false);
});

test("a cloud conversation invokes an installed skill and reads its supporting file", async () => {
  const s = await setup();
  const cloud = await call(router.harnesses.create, { type: "cloud", name: "Cloud", kind: "anthropic", apiKey: "sk-test", model: "m", systemPrompt: "" }, { context: s.context });
  await s.context.db.update(agents).set({ harnessId: cloud.id }).where(eq(agents.id, s.assistant.agentId));
  const model = fakeModel(use("read_skill", { skill: "tidy", path: "references/rules.md" }), say("Tidied"));
  const engine = createEngine(s.context.db, s.context.hub, s.context.secrets, s.context.dataEvents, { client: model.client });
  onTestFinished(() => engine.stop());
  const context = { ...s.context, engine };
  const { runId } = await call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: s.skill.id }, { context });
  await call(router.runs.sendChat, { runId, text: "/tidy:tidy these rows", skillId: s.skill.id }, { context });
  await vi.waitFor(() => expect(model.inputs).toHaveLength(2));
  expect(model.inputs[0]!.system).toContain("- tidy:");
  expect(model.inputs[1]!.items.findLast((i) => i.role === "tool")).toMatchObject({ result: "Trim cells", isError: false });
});

test("a finished conversation discovers native entries without querying its closed session", async () => {
  const s = await setup();
  const runId = await s.engine.startJob(s.assistant.triggerId, s.context.ownerId);
  await vi.waitFor(() => expect(s.sent.some((m) => m.type === "session.start")).toBe(true));
  const start = s.sent.flatMap((m) => m.type === "session.start" ? [m.start] : [])[0]!;
  await s.engine.onHarnessEvent(start.sessionId, { type: "cli-session", cliSessionId: "cli_done" }, { runnerId: s.runnerId, seq: 1 });
  await s.engine.onHarnessEvent(start.sessionId, { type: "result", text: "Done" }, { runnerId: s.runnerId, seq: 2 });
  const discover = vi.spyOn(s.context.hub, "commands").mockResolvedValue({ type: "commands.replied", requestId: "r", commands: [{ name: "native:skill", description: "Native skill" }] });
  const catalog = await call(router.assistantCommands, { agentId: s.assistant.agentId, runId }, { context: s.context });
  expect(catalog.entries).toContainEqual({ name: "native:skill", description: "Native skill", source: "harness" });
  expect(discover.mock.calls[0]![1]).not.toHaveProperty("sessionId");
});

test.each(["disable", "update", "delete"] as const)("%s revokes live runner tools supplied only by an invoked skill", async (change) => {
  const s = await setup();
  await s.context.db.insert(tools).values({ id: "runner_tool", ownerId: s.context.ownerId, name: "Local", kind: "runner", runnerId: s.runnerId, runnerTool: "local", actions: [{ name: "write", description: "Write", inputSchema: {} }] });
  const fields = { name: "local-skill", description: "Local", instructions: "Use local", requiredToolIds: ["runner_tool"] };
  const pkg = await call(router.skills.create, fields, { context: s.context });
  const [skill] = await s.context.db.select().from(skills).where(eq(skills.packageId, pkg.packageId));
  await call(router.jobs.start, { triggerId: s.assistant.triggerId, skillId: skill!.id }, { context: s.context });
  await vi.waitFor(() => expect(s.sent.some((m) => m.type === "session.start")).toBe(true));
  if (change === "disable") await call(router.tools.setActionEnabled, { toolId: "runner_tool", action: "write", enabled: false }, { context: s.context });
  else if (change === "update") await call(router.skills.update, { ...fields, packageId: pkg.packageId, requiredToolIds: [] }, { context: s.context });
  else await call(router.skills.delete, { packageId: pkg.packageId }, { context: s.context });
  const narrowed = s.sent.flatMap((m) => m.type === "session.permissions" ? [m] : []);
  expect(narrowed).toHaveLength(1);
  if (change === "disable") expect(narrowed[0]!.servers[0]?.denied).toContain("write");
  else expect(narrowed[0]!.servers).toEqual([]);
});
