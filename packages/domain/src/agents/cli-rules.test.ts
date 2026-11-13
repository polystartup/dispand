import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, user } from "../db/schema.ts";
import { PLATFORM_TOOLS } from "../platform/tools.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
  return { context, agent };
}

const rules = [
  { cli: "claude-code" as const, rule: "Bash(npm test:*)", decision: "allow" as const },
  { cli: "codex" as const, rule: "FileChange", decision: "deny" as const },
];

test("agents start with no CLI rules; list and removal preserve other rules and agent edits", async () => {
  const { context, agent } = await setup();
  expect(await call(router.agents.cliRules, { id: agent.id }, { context })).toEqual([]);
  await context.db.update(agents).set({ cliRules: rules }).where(eq(agents.id, agent.id));
  expect(await call(router.agents.cliRules, { id: agent.id }, { context })).toEqual(rules);
  expect(await call(router.agents.get, { id: agent.id }, { context })).not.toHaveProperty("cliRules");
  expect((await call(router.agents.list, undefined, { context }))[0]).not.toHaveProperty("cliRules");
  await call(router.agents.update, { id: agent.id, name: "Editor", harnessId: agent.harnessId, systemPrompt: "" }, { context });
  await call(router.agents.removeCliRule, { id: agent.id, cli: "codex", rule: rules[0]!.rule }, { context });
  expect(await call(router.agents.cliRules, { id: agent.id }, { context })).toEqual(rules);
  await call(router.agents.removeCliRule, { id: agent.id, ...rules[0]! }, { context });
  expect(await call(router.agents.cliRules, { id: agent.id }, { context })).toEqual([rules[1]]);
  await call(router.agents.removeCliRule, { id: agent.id, ...rules[0]! }, { context });
  expect(await call(router.agents.cliRules, { id: agent.id }, { context })).toEqual([rules[1]]);
  await call(router.agents.update, { id: agent.id, name: "Editor", harnessId: agent.harnessId, systemPrompt: "Updated notes." }, { context });
  expect(await call(router.agents.cliRules, { id: agent.id }, { context })).toEqual([rules[1]]);
});

test("concurrent removals keep each other's changes", async () => {
  const { context, agent } = await setup();
  await context.db.update(agents).set({ cliRules: rules }).where(eq(agents.id, agent.id));
  await Promise.all(rules.map((rule) => call(router.agents.removeCliRule, { id: agent.id, ...rule }, { context })));
  expect(await call(router.agents.cliRules, { id: agent.id }, { context })).toEqual([]);
});

test("CLI rule controls require the agent's owner session and are absent from Job tools", async () => {
  const { context, agent } = await setup();
  await context.db.insert(user).values({ id: "other", name: "Other", email: "other@example.test" });
  await context.db.insert(agents).values({ id: "other_agent", ownerId: "other", name: "Other", harnessId: agent.harnessId, systemPrompt: "", cliRules: rules });
  for (const id of ["other_agent", "missing"]) {
    await expect(call(router.agents.cliRules, { id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(router.agents.removeCliRule, { id, ...rules[0]! }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  const job = { ...context, job: { runId: "run", ownerId: context.ownerId, agentId: agent.id } };
  await expect(call(router.agents.cliRules, { id: agent.id }, { context: job })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(router.agents.removeCliRule, { id: agent.id, ...rules[0]! }, { context: job })).rejects.toMatchObject({ code: "FORBIDDEN" });
  const guest = { ...context, headers: new Headers() };
  await expect(call(router.agents.cliRules, { id: agent.id }, { context: guest })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(call(router.agents.removeCliRule, { id: agent.id, ...rules[0]! }, { context: guest })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(PLATFORM_TOOLS.some((tool) => ["agents.cliRules", "agents.removeCliRule"].includes(tool.path))).toBe(false);
});
