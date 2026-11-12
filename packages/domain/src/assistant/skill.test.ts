import { call } from "@orpc/server";
import type { ServerToRunner } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { agentSkills, proposals, runs, skillFiles, skillPackages } from "../db/schema.ts";
import { ASK_USER, READ_SKILL, REQUEST_APPROVAL, SUBMIT_OUTPUTS } from "../cloud/builtins.ts";
import { fakeModel, say, use } from "../cloud/test-model.ts";
import { CliHarnessAdapter, createEngine } from "../engine/cli-harness.ts";
import { Engine } from "../engine/engine.ts";
import { toolingOf } from "../engine/tooling.ts";
import { callPlatformTool } from "../platform/call.ts";
import { APPLY, INBOX_TOOLS, PLATFORM_TOOLS, PROPOSE } from "../platform/tools.ts";
import { router } from "../rpc/router.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { packageForRunner } from "../skills/runner-access.ts";
import { PLATFORM_SKILL, PLATFORM_SKILL_FILES, syncPlatformSkill, syncPlatformSkills } from "./skill.ts";

const text = (content: Uint8Array) => new TextDecoder().decode(content);

async function filesOf(context: Awaited<ReturnType<typeof ownerContext>>, packageId: string) {
  const rows = await context.db.select().from(skillFiles).where(eq(skillFiles.packageId, packageId));
  return Object.fromEntries(rows.map((r) => [r.path, text(r.content)]));
}

const build = Object.fromEntries(PLATFORM_SKILL_FILES.map((f) => [f.path, text(f.content)]));

async function withAssistant() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const ids = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context });
  const agent = await call(router.agents.get, { id: ids.agentId }, { context });
  const fields = { id: agent.id, name: agent.name, harnessId: agent.harnessId, systemPrompt: agent.systemPrompt, skillPackageIds: agent.skills.map((s) => s.packageId), toolIds: [] };
  return { context, runnerId, harness, ...ids, agent, fields };
}

test("the build's files are a valid package of one skill, and name only tools Dispand has", () => {
  expect(Object.keys(build)).toContain(`${PLATFORM_SKILL}/SKILL.md`);
  expect(Object.keys(build).every((path) => path.startsWith(`${PLATFORM_SKILL}/`))).toBe(true);
  // A tool the skill names in code (`rows_list`) is one an agent can be given.
  const names = new Set([...PLATFORM_TOOLS, PROPOSE, APPLY, ...INBOX_TOOLS].map((t) => t.name).concat([ASK_USER, REQUEST_APPROVAL, READ_SKILL, SUBMIT_OUTPUTS]));
  const named = Object.values(build).flatMap((md) => [...md.matchAll(/`([a-z]+(?:_[a-z]+)+|propose)`/g)].map((m) => m[1]!));
  expect(named.length).toBeGreaterThan(10);
  expect(named.filter((n) => !names.has(n))).toEqual([]);
});

test("start writes every owner's platform skill from the build's files, and puts back what changed", async () => {
  const context = await ownerContext();
  await syncPlatformSkills(context.db);
  const [pkg] = await context.db.select().from(skillPackages).where(eq(skillPackages.ownerId, context.ownerId));
  expect(pkg).toMatchObject({ name: PLATFORM_SKILL, builtIn: true, pluginId: null });
  expect(await filesOf(context, pkg!.id)).toEqual(build);

  // A file changed, one gone, one added: the next start writes the build's files again.
  const [first, second] = PLATFORM_SKILL_FILES;
  await context.db.update(skillFiles).set({ content: new TextEncoder().encode("old") }).where(eq(skillFiles.path, first!.path));
  await context.db.delete(skillFiles).where(eq(skillFiles.path, second!.path));
  await context.db.insert(skillFiles).values({ packageId: pkg!.id, path: `${PLATFORM_SKILL}/old.md`, content: new TextEncoder().encode("old") });
  expect(await syncPlatformSkill(context.db, context.ownerId)).toBe(pkg!.id);
  expect(await filesOf(context, pkg!.id)).toEqual(build);
  // Twice, and twice at once: still one package.
  await Promise.all([syncPlatformSkill(context.db, context.ownerId), syncPlatformSkill(context.db, context.ownerId)]);
  expect(await context.db.select().from(skillPackages).where(eq(skillPackages.ownerId, context.ownerId))).toHaveLength(1);
});

test("the platform skill is read-only to the owner, and its name is kept for it", async () => {
  const { context } = await withAssistant();
  const { packageId } = (await call(router.skills.list, undefined, { context })).find((p) => p.name === PLATFORM_SKILL)!;
  expect((await call(router.skills.list, undefined, { context })).find((p) => p.packageId === packageId)).toMatchObject({ builtIn: true, plugin: null });
  const fields = { name: PLATFORM_SKILL, description: "Mine.", instructions: "x", requiredToolIds: [] };
  await expect(call(router.skills.update, { packageId, ...fields }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", message: "The platform skill is built in: it is read-only" });
  await expect(call(router.skills.update, { packageId, ...fields, name: "renamed" }, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(router.skills.delete, { packageId }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", message: "The platform skill is built in: it is read-only" });
  await expect(call(router.skills.create, fields, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  const mine = await call(router.skills.create, { ...fields, name: "mine" }, { context });
  await expect(call(router.skills.update, { packageId: mine.packageId, ...fields }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await filesOf(context, packageId)).toEqual(build);
});

test("the Assistant has the platform skill, and neither the owner nor a proposal takes it away", async () => {
  const { context, agentId, triggerId, agent, fields } = await withAssistant();
  const [pkg] = await context.db.select().from(skillPackages).where(eq(skillPackages.builtIn, true));
  expect(agent.skills).toEqual([{ packageId: pkg!.id, name: PLATFORM_SKILL }]);

  const mine = await call(router.skills.create, { name: "mine", description: "Mine.", instructions: "x", requiredToolIds: [] }, { context });
  const reason = "The Assistant keeps its platform skill";
  await expect(call(router.agents.update, { ...fields, skillPackageIds: [] }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", message: reason });
  await expect(call(router.agents.update, { ...fields, skillPackageIds: [mine.packageId] }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", message: reason });
  // Left out, the list is empty: that drops it too.
  await expect(call(router.agents.update, { ...fields, skillPackageIds: undefined }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", message: reason });
  // Other skills come and go beside it.
  await call(router.agents.update, { ...fields, skillPackageIds: [pkg!.id, mine.packageId] }, { context });
  await call(router.agents.update, fields, { context });

  const job = { runId: (await call(router.jobs.start, { triggerId }, { context })).runId, ownerId: context.ownerId, agentId };
  const proposed = await callPlatformTool(context, job, "propose", { items: [{ tool: "agents_update", input: { ...fields, skillPackageIds: [] } }] });
  expect(JSON.stringify(proposed)).toContain(`Item 1 (agents_update): ${reason}`);
  expect(await context.db.select().from(proposals).where(eq(proposals.runId, job.runId))).toEqual([]);
  expect(await context.db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId))).toEqual([{ agentId, packageId: pkg!.id }]);
});

test("the Assistant's Job gets the platform skill, on a runner and on a cloud harness", async () => {
  const { context, runnerId, agentId, triggerId, fields } = await withAssistant();
  const packageId = fields.skillPackageIds[0]!;

  // A runner session: its start names the package, and the runner may fetch its files.
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_id: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const engine = new Engine(context.db, new CliHarnessAdapter(context.db, hub as unknown as RunnerHub, context.secrets), undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  await engine.startJob(triggerId, context.ownerId);
  await vi.waitFor(() => expect(sent.some((m) => m.type === "session.start")).toBe(true));
  const start = sent.flatMap((m) => (m.type === "session.start" ? [m.start] : []))[0]!;
  expect(start.skills).toEqual([{ packageId, name: PLATFORM_SKILL }]);
  const fetched = await packageForRunner(context.db, runnerId, packageId);
  expect(Object.fromEntries(fetched!.files.map((f) => [f.path, Buffer.from(f.base64, "base64").toString()]))).toEqual(build);

  // A cloud session: its tooling lists it.
  const cloud = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context });
  await call(router.agents.update, { ...fields, harnessId: cloud.id }, { context });
  const { runId } = await call(router.jobs.start, { triggerId }, { context });
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  expect((await toolingOf(context.db, run!, agentId)).skills).toEqual([{ packageId, name: PLATFORM_SKILL }]);
});

test("the Assistant on a cloud harness reads the platform skill", async () => {
  const { context, triggerId, fields } = await withAssistant();
  const path = "SKILL.md";
  const model = fakeModel(use("read_skill", { skill: PLATFORM_SKILL, path }), say("I know Dispand."));
  const engine = createEngine(context.db, context.hub, context.secrets, context.dataEvents, { client: model.client });
  onTestFinished(() => engine.stop());
  const cloud = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context });
  await call(router.agents.update, { ...fields, harnessId: cloud.id }, { context });
  const { runId } = await call(router.jobs.start, { triggerId }, { context: { ...context, engine } });
  // Its chat has no instructions: the owner's first message is its first turn.
  await engine.sendChat(runId, "What is Dispand?");
  await vi.waitFor(() => expect(model.inputs).toHaveLength(2));
  expect(model.inputs[0]!.items).toEqual([{ role: "user", text: "What is Dispand?" }]);
  expect(model.inputs[0]!.system).toContain(`- ${PLATFORM_SKILL}: `);
  const read = model.inputs[1]!.items.findLast((i) => i.role === "tool");
  expect(read).toMatchObject({ result: build[`${PLATFORM_SKILL}/${path}`], isError: false });
});

test("another agent can be given the platform skill: it describes, and grants nothing", async () => {
  const { context, harness } = await withAssistant();
  const [pkg] = await context.db.select().from(skillPackages).where(eq(skillPackages.builtIn, true));
  const clerk = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", skillPackageIds: [pkg!.id] }, { context });
  expect(clerk).toMatchObject({ bundles: [], dataTables: "all" });
  expect((await call(router.agents.get, { id: clerk.id }, { context })).skills).toEqual([{ packageId: pkg!.id, name: PLATFORM_SKILL }]);
  // And taken back.
  await call(router.agents.update, { id: clerk.id, name: "Clerk", harnessId: harness.id, systemPrompt: "", skillPackageIds: [] }, { context });
  expect((await call(router.agents.get, { id: clerk.id }, { context })).skills).toEqual([]);
});
