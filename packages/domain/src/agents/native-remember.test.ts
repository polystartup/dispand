import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, questions, runs, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { offerForQuestion, remember, toolAnswerPermission } from "./remember.ts";

async function setup(cli: "claude-code" | "codex" = "claude-code") {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "CLI", runnerId, kind: cli, permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Work", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  const payload = { kind: "permission" as const, toolName: cli === "codex" ? "Shell" : "Bash", input: { command: "npm test" }, canAlwaysAllow: true, remembers: cli === "codex" ? 'Shell:["npm","test"]' : "Bash(npm test:*)" };
  const input = { ownerId: context.ownerId, sessionId: step!.sessionId!, questionId: "rq_native", payload, harness: cli };
  const offer = await offerForQuestion(context.db, input);
  await context.db.insert(questions).values({ id: "q_native", ownerId: context.ownerId, runId, stepRunId: step!.id, sessionId: step!.sessionId!, placement: "chat", kind: "approval", payload, remember: offer?.remember, status: "pending" });
  const by = { type: "user" as const, userId: context.ownerId };
  const state = async () => (await context.db.select().from(runs).where(eq(runs.id, runId)))[0]!.remembered;
  const saved = async () => (await context.db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.cliRules;
  return { context, agent, trigger, step: step!, runId, payload, input, offer, by, state, saved };
}

test.each(["claude-code", "codex"] as const)("%s offers owner memory bound to the stored session's CLI and agent", async (cli) => {
  const s = await setup(cli);
  expect(s.offer?.remember).toMatchObject({ scopes: ["run", "always"], subject: { kind: "cli", agentId: s.agent.id, cli, rule: s.payload.remembers } });
  if (cli === "codex") expect(s.offer?.remember).toMatchObject({ decisions: ["allow"] });
  expect(await offerForQuestion(s.context.db, { ...s.input, harness: "openai", payload: { ...s.payload, toolName: "mcp__mail__send" } })).toBeNull();
  expect(await offerForQuestion(s.context.db, { ...s.input, payload: { ...s.payload, remembers: "Read(//etc/**)" } })).toBeNull();
});

test.each(["run", "always"] as const)("native %s decisions are owner-only, isolated and replace the same rule", async (scope) => {
  const s = await setup();
  const input = { questionId: "q_native", scope, decision: "allow" as const, by: s.by };
  expect(await remember(s.context.db, { ...input, by: { type: "agent", agentId: s.agent.id, runId: s.runId, name: "Writer" } })).toBe(false);
  expect(await remember(s.context.db, input)).toBe(true);
  if (scope === "always") expect(await s.saved()).toEqual([{ cli: "claude-code", rule: s.payload.remembers, decision: "allow" }]);
  else expect(await s.state()).toEqual({ allow: [s.offer!.remember.subject], deny: [] });
  expect(await remember(s.context.db, { ...input, decision: "deny" })).toBe(true);
  if (scope === "always") expect(await s.saved()).toEqual([{ cli: "claude-code", rule: s.payload.remembers, decision: "deny" }]);
  else expect(await s.state()).toEqual({ allow: [], deny: [s.offer!.remember.subject] });
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  expect((await s.context.db.select().from(runs).where(eq(runs.id, runId)))[0]!.remembered).toEqual({ allow: [], deny: [] });
});

test.each(["run", "always"] as const)("Codex cannot save a %s native denial", async (scope) => {
  const s = await setup("codex");
  expect(await remember(s.context.db, { questionId: "q_native", decision: "deny", scope, by: s.by })).toBe(false);
  expect(await s.state()).toEqual({ allow: [], deny: [] });
  expect(await s.saved()).toEqual([]);
  expect(await remember(s.context.db, { questionId: "q_native", decision: "allow", scope, by: s.by })).toBe(true);
});

test("a removed rule downgrades an undelivered native grant to one call", async () => {
  const s = await setup();
  const input = { questionId: "q_native", decision: "allow" as const, scope: "always" as const, by: s.by };
  expect(await remember(s.context.db, input)).toBe(true);
  const [q] = await s.context.db.select().from(questions).where(eq(questions.id, "q_native"));
  expect(await toolAnswerPermission(s.context.db, q!)).toBe("remember");
  await call(router.agents.removeCliRule, { id: s.agent.id, cli: "claude-code", rule: s.payload.remembers }, { context: s.context });
  expect(await toolAnswerPermission(s.context.db, q!)).toBe("once");
  await s.context.db.update(stepRuns).set({ harness: { id: s.step.harness!.id, runnerId: s.step.runnerId!, kind: "codex", permissionMode: "default" } }).where(eq(stepRuns.id, s.step.id));
  expect(await toolAnswerPermission(s.context.db, q!)).toBe("deny");
});

test("native candidates cannot grant workflow, inactive, foreign-owner or missing-token scopes", async () => {
  const s = await setup();
  expect(await offerForQuestion(s.context.db, { ...s.input, ownerId: "another-owner" })).toBeNull();
  await s.context.db.update(runs).set({ tokenSealed: null }).where(eq(runs.id, s.runId));
  expect(await offerForQuestion(s.context.db, s.input)).toBeNull();
  await s.context.db.update(runs).set({ tokenSealed: "sealed", status: "succeeded" }).where(eq(runs.id, s.runId));
  expect(await offerForQuestion(s.context.db, s.input)).toBeNull();
  await s.context.db.update(runs).set({ status: "running", source: "workflow" }).where(eq(runs.id, s.runId));
  expect(await offerForQuestion(s.context.db, s.input)).toBeNull();
});

test("native scopes roll back with the answer transaction", async () => {
  const s = await setup();
  await expect(s.context.db.transaction(async (tx) => {
    expect(await remember(tx, { questionId: "q_native", decision: "allow", scope: "always", by: s.by })).toBe(true);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(await s.saved()).toEqual([]);
});
