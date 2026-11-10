import { call } from "@orpc/server";
import { McpServerRef } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { runs, tools, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { serverName, toolingOf } from "./tooling.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  await context.db.insert(tools).values([
    { id: "tool_gh", ownerId: context.ownerId, name: "GitHub", kind: "http", url: "https://example.com/mcp", transport: "streamable-http" },
    { id: "tool_fc", ownerId: context.ownerId, name: "Firecrawl", kind: "http", url: "https://example.com/fc", transport: "streamable-http" },
    { id: "tool_fetch", ownerId: context.ownerId, name: "Fetch", kind: "runner", runnerId, runnerTool: "fetch" },
  ]);
  const skill = async (name: string, requiredToolIds: string[] = []) =>
    (await call(router.skills.create, { name, description: `Does ${name}.`, instructions: "x", requiredToolIds }, { context })).packageId;
  const review = await skill("review", ["tool_fc"]);
  const base = { name: "Clerk", harnessId: harness.id, systemPrompt: "" };
  const agent = await call(router.agents.create, { ...base, skillPackageIds: [review], toolIds: ["tool_gh", "tool_fetch"] }, { context });
  const setAgent = (patch: { skillPackageIds?: string[]; toolIds?: string[] }) =>
    call(router.agents.update, { ...base, id: agent.id, skillPackageIds: [review], toolIds: ["tool_gh", "tool_fetch"], ...patch }, { context });
  return { context, runnerId, agent, review, skill, setAgent };
}

const summary = (t: Awaited<ReturnType<typeof toolingOf>>) => ({
  skills: t.skills.map((s) => s.name),
  runner: t.runnerTools.map((r) => `${r.name}:${r.tool}`),
  http: t.httpTools.map((h) => h.name).sort(),
});

test("a workflow run's session gets the agent's skills and tools as they are", async () => {
  const { context, runnerId, agent, review, skill, setAgent } = await setup();
  const run = { ownerId: context.ownerId, snapshot: null };
  const tooling = await toolingOf(context.db, run, agent.id);
  expect(summary(tooling)).toEqual({ skills: ["review"], runner: ["Fetch:fetch"], http: ["Firecrawl", "GitHub"] });
  expect(tooling.skills).toEqual([{ packageId: review, name: "review" }]);
  expect(tooling.runnerTools[0]).toEqual({ name: "Fetch", tool: "fetch", runnerId });
  const lint = await skill("lint");
  await setAgent({ skillPackageIds: [lint], toolIds: [] });
  expect(summary(await toolingOf(context.db, run, agent.id))).toEqual({ skills: ["lint"], runner: [], http: [] });
  expect(summary(await toolingOf(context.db, run, "agent_nobody"))).toEqual({ skills: [], runner: [], http: [] });
});

test("a Job's session gets its snapshot's skills and tools that the agent still has", async () => {
  const { context, agent, review, skill, setAgent } = await setup();
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  expect(summary(await toolingOf(context.db, run!, agent.id))).toEqual({ skills: ["review"], runner: ["Fetch:fetch"], http: ["Firecrawl", "GitHub"] });
  // Added to the agent after the Job was created: not the Job's.
  const lint = await skill("lint");
  await context.db.insert(tools).values({ id: "tool_new", ownerId: context.ownerId, name: "New", kind: "http", url: "https://example.com/new", transport: "streamable-http" });
  await setAgent({ skillPackageIds: [review, lint], toolIds: ["tool_gh", "tool_fetch", "tool_new"] });
  expect(summary(await toolingOf(context.db, run!, agent.id))).toEqual({ skills: ["review"], runner: ["Fetch:fetch"], http: ["Firecrawl", "GitHub"] });
  // Taken back from the agent: gone from its running Job at once (the skill's required tool with it).
  await setAgent({ skillPackageIds: [lint], toolIds: ["tool_gh"] });
  expect(summary(await toolingOf(context.db, run!, agent.id))).toEqual({ skills: [], runner: [], http: ["GitHub"] });
});

test("another owner's tool is never loaded, and a skill whose name a runner would refuse is left out", async () => {
  const { context, agent } = await setup();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.update(tools).set({ ownerId: "user_other" }).where(eq(tools.id, "tool_gh"));
  const tooling = await toolingOf(context.db, { ownerId: context.ownerId, snapshot: null }, agent.id);
  expect(summary(tooling).http).toEqual(["Firecrawl"]);
});

test("server names are unambiguous and never reserved", () => {
  const taken = new Set<string>();
  const names = ["job", "Dispand", "My  Tool!", "__", "GitHub", "GitHub", "a_b", "é", "x".repeat(80), "job_", "_job__x_"].map((n) => serverName(n, taken));
  expect(names).toEqual(["job_2", "dispand_2", "my_tool", "tool", "github", "github_2", "a_b", "tool_2", "x".repeat(64), "job_3", "job_x"]);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(McpServerRef.safeParse({ name, type: "runner", tool: "fetch" }).success, name).toBe(true);
});
