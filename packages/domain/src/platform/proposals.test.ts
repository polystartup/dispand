import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, proposals } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { Bundle } from "./bundles.ts";
import { callPlatformTool, toolsOf, type JobIdentity } from "./call.ts";
import { PLATFORM_TOOLS } from "./tools.ts";

/** An agent with `bundles`, a Job of it still going, and what its tools answer. */
async function setup(bundles: Bundle[] = ["configure"]) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const base = { name: "Builder", harnessId: harness.id, systemPrompt: "" };
  const agent = await call(router.agents.create, { ...base, bundles }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const start = async (): Promise<JobIdentity> => ({ runId: (await call(router.jobs.start, { triggerId: trigger.id }, { context })).runId, ownerId: context.ownerId, agentId: agent.id });
  const job = await start();
  const tool = (name: string, input: unknown = {}, as = job) => callPlatformTool(context, as, name, input);
  const propose = async (items: unknown, as = job) => tool("propose", { items }, as);
  /** As the owner's answer will do (Task 3): here, straight in the row. */
  const settle = (proposalId: string, status: "asked" | "approved" | "declined") => context.db.update(proposals).set({ status }).where(eq(proposals.id, proposalId));
  const idOf = (result: unknown) => (result as { output: { proposalId: string } }).output.proposalId;
  const newAgent = { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief.", skillPackageIds: [], toolIds: [], bundles: ["data"], dataTables: "all" };
  return { context, harness, agent, base, job, start, tool, propose, settle, idOf, newAgent };
}

const NEEDS = /needs the owner's approval/;

test("propose stores the listed writes as they parse, as a draft, and says what to do next", async () => {
  const s = await setup();
  expect((await toolsOf(s.context.db, s.job)).map((t) => t.name)).toEqual(expect.arrayContaining(["propose", "agents_create", "agents_update", "agents_list", "agents_get"]));
  const made = await s.propose([{ tool: "agents_create", input: s.newAgent }, { tool: "agents_update", input: { ...s.base, id: s.agent.id, systemPrompt: "New." } }]);
  expect(made).toMatchObject({ ok: true, output: { proposalId: expect.stringMatching(/^prop_/), next: expect.stringContaining("request_approval") } });
  const [row] = await s.context.db.select().from(proposals);
  expect(row).toMatchObject({ id: s.idOf(made), ownerId: s.context.ownerId, runId: s.job.runId, agentId: s.agent.id, status: "draft", questionId: null });
  expect(row!.items.map((i) => i.tool)).toEqual(["agents_create", "agents_update"]);
  expect(row!.items[0]!.input).toMatchObject({ name: "Clerk", bundles: ["data"] });
});

test("a proposal that can't be made is refused with the reason, and nothing is stored", async () => {
  const s = await setup();
  const item = { tool: "agents_create", input: s.newAgent };
  const cases: [unknown, RegExp][] = [
    [[], /at least one/],
    [[{ tool: "agents_delete", input: {} }], /agents_delete/],
    // Not a write that needs a proposal: it is made directly.
    [[{ tool: "tables_create", input: { name: "X" } }], /tables_create/],
    [[{ tool: "agents_create", input: { ...s.newAgent, name: "" } }], /name/],
    [Array.from({ length: 21 }, () => item), /20/],
    [[{ tool: "agents_create", input: { ...s.newAgent, systemPrompt: "x".repeat(70_000) } }], /too large/],
    [[{ tool: "agents_create", input: { ...s.newAgent, systemPrompt: "a\u0000b" } }], /store/],
  ];
  for (const [items, reason] of cases) {
    const refused = await s.propose(items);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toMatch(reason);
  }
  expect(await s.context.db.select().from(proposals)).toHaveLength(0);
  // An agent without `configure` has no `propose`.
  const data = await setup(["data"]);
  expect(await data.propose([item])).toMatchObject({ ok: false, error: "This agent may not use propose" });
});

test("a grant write runs only on an approved, unused, identical item of the same Job", async () => {
  const s = await setup();
  const names = async () => (await s.context.db.select({ name: agents.name }).from(agents)).map((a) => a.name).sort();
  const create = () => s.tool("agents_create", s.newAgent);
  expect(((await create()) as { error: string }).error).toMatch(NEEDS);
  const id = s.idOf(await s.propose([{ tool: "agents_create", input: s.newAgent }]));
  // A draft, one that is asked and one that was declined allow nothing.
  for (const status of ["asked", "declined"] as const) {
    expect(((await create()) as { error: string }).error).toMatch(NEEDS);
    await s.settle(id, status);
  }
  expect(((await create()) as { error: string }).error).toMatch(NEEDS);
  await s.settle(id, "approved");
  // Another Job of the same agent, and a changed input, get nothing from it.
  expect(((await s.tool("agents_create", s.newAgent, await s.start())) as { error: string }).error).toMatch(NEEDS);
  expect(((await s.tool("agents_create", { ...s.newAgent, bundles: ["data", "configure"] })) as { error: string }).error).toMatch(NEEDS);
  expect(await names()).toEqual(["Builder"]);
  // Key order aside, the listed write runs, once.
  const reordered = Object.fromEntries(Object.entries(s.newAgent).reverse());
  expect(await s.tool("agents_create", reordered)).toMatchObject({ ok: true, output: { name: "Clerk", bundles: ["data"] } });
  expect(((await create()) as { error: string }).error).toMatch(NEEDS);
  expect(await names()).toEqual(["Builder", "Clerk"]);
});

test("one approved item, two calls at once: exactly one runs", async () => {
  const s = await setup();
  const id = s.idOf(await s.propose([{ tool: "agents_create", input: s.newAgent }]));
  await s.settle(id, "approved");
  const results = await Promise.all([s.tool("agents_create", s.newAgent), s.tool("agents_create", s.newAgent)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect((await s.context.db.select().from(agents)).filter((a) => a.name === "Clerk")).toHaveLength(1);
});

test("an approval doesn't bring back a right taken since, nor skip the procedure's own checks", async () => {
  const s = await setup();
  const foreign = { ...s.newAgent, harnessId: "harness_missing" };
  const id = s.idOf(await s.propose([{ tool: "agents_create", input: s.newAgent }, { tool: "agents_create", input: foreign }]));
  await s.settle(id, "approved");
  // What isn't the owner's is still refused by the procedure.
  expect(await s.tool("agents_create", foreign)).toMatchObject({ ok: false });
  // The agent loses `configure`: its approved item is of no use.
  await call(router.agents.update, { ...s.base, id: s.agent.id, bundles: [] }, { context: s.context });
  expect(await s.tool("agents_create", s.newAgent)).toMatchObject({ ok: false, error: "This agent may not use agents_create" });
});

test("every tool marked as a grant is refused without a proposal", async () => {
  const s = await setup(["data", "configure"]);
  const grants = PLATFORM_TOOLS.filter((t) => t.grant);
  expect(grants.map((t) => t.name).sort()).toEqual(["agents_create", "agents_update"]);
  for (const t of grants) {
    const input = t.name === "agents_update" ? { ...s.base, id: s.agent.id } : s.newAgent;
    expect(((await s.tool(t.name, input)) as { error: string }).error).toMatch(NEEDS);
  }
});
