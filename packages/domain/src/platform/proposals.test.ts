import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { agents, agentTools, fields as fieldsTable, proposals, questions, stepRuns, tables as tablesTable, tools as toolsTable, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { startFakeMcp } from "../tools/test-server.ts";
import type { Bundle } from "./bundles.ts";
import { callPlatformTool, toolsOf, type JobIdentity } from "./call.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
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
  let seq = 0;
  /** The session asks with `request_approval`, as the runner sends it; gives the question's id. */
  const ask = async (input: Record<string, unknown>, as = job) => {
    const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, as.runId));
    const n = ++seq;
    await context.engine.onHarnessEvent(step!.sessionId!, { type: "question", questionId: `rq_${n}`, payload: { kind: "permission", toolName: "request_approval", input: input as never, canAlwaysAllow: false } }, { runnerId, seq: n });
    const [q] = await context.db.select().from(questions).where(eq(questions.runnerQuestionId, `rq_${n}`));
    return q!.id;
  };
  const answer = (questionId: string, decision: "allow" | "deny") => call(router.questions.answer, { questionId, answer: { kind: "permission", decision } }, { context });
  const statusOf = async (proposalId: string) => (await context.db.select().from(proposals).where(eq(proposals.id, proposalId)))[0]!.status;
  const tool = (name: string, input: unknown = {}, as = job) => callPlatformTool(context, as, name, input);
  const propose = async (items: unknown, as = job) => tool("propose", { items }, as);
  /** As the owner's answer will do (Task 3): here, straight in the row. */
  const settle = (proposalId: string, status: "asked" | "approved" | "declined") => context.db.update(proposals).set({ status }).where(eq(proposals.id, proposalId));
  const idOf = (result: unknown) => (result as { output: { proposalId: string } }).output.proposalId;
  const newAgent = { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief.", skillPackageIds: [], toolIds: [], bundles: ["data"], dataTables: "all" };
  return { context, harness, agent, base, job, start, tool, propose, settle, idOf, newAgent, ask, answer, statusOf };
}

const NEEDS = /needs the owner's approval/;

test("propose stores the listed writes as they parse, as a draft, and says what to do next", async () => {
  const s = await setup();
  expect((await toolsOf(s.context.db, s.job)).map((t) => t.name)).toEqual(expect.arrayContaining(["propose", "agents_create", "agents_update", "agents_list", "agents_get"]));
  const made = await s.propose([{ tool: "agents_create", input: s.newAgent }, { tool: "agents_update", input: { ...s.base, id: s.agent.id, systemPrompt: "New." } }]);
  expect(made).toMatchObject({ ok: true, output: { proposalId: expect.stringMatching(/^prop_/), next: expect.stringMatching(/the tool request_approval \(in Claude Code it is mcp__dispand__request_approval, not a tool of the job server\)/) } });
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
    // The refusal names what can be proposed, so the agent finds its way.
    [[{ tool: "agents_delete", input: {} }], /agents_delete is not a write you can propose.*agents_create.*tables_delete/],
    // A read is never an item: it is called directly.
    [[{ tool: "tables_list", input: {} }], /tables_list is not a write you can propose.*tables_create/],
    // The item's input is checked as a direct call checks it, with the same words.
    [[{ tool: "fields_create", input: { tableId: "tbl_x", name: "Notes", type: "long text" } }], /^Item 1 \(fields_create\): type: Invalid option: expected one of .*"long-text"/],
    // A malformed list says what is wrong with it.
    [[{ tool: "tables_create", input: '{"name":"X"}' }], /items\.0\.input/],
    [[{ tool: "agents_create", input: { ...s.newAgent, name: "" } }], /name/],
    [Array.from({ length: 61 }, () => item), /60/],
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

test("setting an agent's self-learning targets from a Job is a grant: it runs only on an approved item", async () => {
  const s = await setup();
  const input = { ...s.base, id: s.agent.id, selfLearning: ["workspace"] };
  const targets = async () => (await s.context.db.select({ selfLearning: agents.selfLearning }).from(agents).where(eq(agents.id, s.agent.id)))[0]!.selfLearning;
  expect(((await s.tool("agents_update", input)) as { error: string }).error).toMatch(NEEDS);
  expect(await targets()).toEqual([]);
  const id = s.idOf(await s.propose([{ tool: "agents_update", input }]));
  expect(((await s.tool("agents_update", input)) as { error: string }).error).toMatch(NEEDS);
  await s.settle(id, "approved");
  // Another target than the one approved gets nothing from it.
  expect(((await s.tool("agents_update", { ...input, selfLearning: ["agent", "workspace"] })) as { error: string }).error).toMatch(NEEDS);
  expect(await s.tool("agents_update", input)).toMatchObject({ ok: true, output: { selfLearning: ["workspace"] } });
  expect(await targets()).toEqual(["workspace"]);
  // A new agent's targets go through an approved item too.
  expect(((await s.tool("agents_create", { ...s.newAgent, selfLearning: ["agent"] })) as { error: string }).error).toMatch(NEEDS);
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
  expect(grants.map((t) => t.name).sort()).toEqual(["agents_create", "agents_set_tool_ask", "agents_update", "fields_delete", "harnesses_set_limit", "tables_delete", "tools_add", "tools_add_from_catalog", "tools_delete", "triggers_create", "triggers_delete", "triggers_update", "workspace_set_checkpoint"]);
  const table = await call(router.tables.create, { name: "Clients" }, { context: s.context });
  const field = (await call(router.tables.get, { id: table.id }, { context: s.context })).fields[0]!;
  const inputs: Record<string, unknown> = {
    agents_create: s.newAgent,
    agents_update: { ...s.base, id: s.agent.id },
    agents_set_tool_ask: { agentId: s.agent.id, toolId: "tool_x", action: "send", ask: false },
    tables_delete: { id: table.id },
    fields_delete: { id: field.id },
    triggers_create: { agentId: s.agent.id, name: "Daily", instructions: "Work.", config: { kind: "manual", placement: "button" } },
    triggers_update: { id: "trigger_x", enabled: false },
    triggers_delete: { id: "trigger_x" },
    tools_add: { name: "Mail", url: "https://mail.example.com/mcp", transport: "streamable-http" },
    tools_add_from_catalog: { catalogId: "firecrawl" },
    tools_delete: { id: "tool_x" },
    harnesses_set_limit: { id: s.agent.harnessId, maxWorking: 10 },
    workspace_set_checkpoint: { checkpoint: 500 },
  };
  for (const t of grants) expect(((await s.tool(t.name, inputs[t.name])) as { error: string }).error).toMatch(NEEDS);
});

test("request_approval with a proposal's id asks for that proposal: the owner's yes approves it, and the listed write then runs", async () => {
  const s = await setup();
  const id = s.idOf(await s.propose([{ tool: "agents_create", input: s.newAgent }]));
  const q = await s.ask({ message: "May I add a clerk?", proposal: id });
  expect(await s.statusOf(id)).toBe("asked");
  const [row] = await s.context.db.select().from(questions).where(eq(questions.id, q));
  expect(row).toMatchObject({ kind: "approval", proposalId: id });
  expect(((await s.tool("agents_create", s.newAgent)) as { error: string }).error).toMatch(NEEDS);
  await s.answer(q, "allow");
  expect(await s.statusOf(id)).toBe("approved");
  expect(await s.tool("agents_create", s.newAgent)).toMatchObject({ ok: true, output: { name: "Clerk" } });
});

test("a no declines the proposal for good; a proposal has one question and one answer", async () => {
  const s = await setup();
  const id = s.idOf(await s.propose([{ tool: "agents_create", input: s.newAgent }]));
  // Two requests name the same draft: one attaches it.
  const first = await s.ask({ message: "One?", proposal: id });
  const second = await s.ask({ message: "Two?", proposal: id });
  const attached = (await s.context.db.select().from(questions)).filter((q) => q.proposalId === id);
  expect(attached).toHaveLength(1);
  const other = attached[0]!.id === first ? second : first;
  await s.answer(attached[0]!.id, "deny");
  expect(await s.statusOf(id)).toBe("declined");
  // Approving the other request approves its words only; asking again attaches nothing.
  await s.answer(other, "allow");
  const again = await s.ask({ message: "Again?", proposal: id });
  await s.answer(again, "allow");
  expect(await s.statusOf(id)).toBe("declined");
  expect(((await s.tool("agents_create", s.newAgent)) as { error: string }).error).toMatch(NEEDS);
});

test("a request names only a draft of its own Job: anything else attaches nothing", async () => {
  const s = await setup();
  const id = s.idOf(await s.propose([{ tool: "agents_create", input: s.newAgent }]));
  const otherJob = await s.start();
  for (const [input, as] of [
    [{ message: "Hi", proposal: id }, otherJob],
    [{ message: "Hi", proposal: "prop_missing" }, s.job],
    [{ message: "Hi", proposal: 42 }, s.job],
    [{ message: "Hi" }, s.job],
  ] as const) {
    const q = await s.ask(input, as);
    const [row] = await s.context.db.select().from(questions).where(eq(questions.id, q));
    expect(row!.proposalId).toBeNull();
    await s.answer(q, "allow");
  }
  expect(await s.statusOf(id)).toBe("draft");
});

test("the Inbox reads a proposal from the server's row, with a name for every id its items point at", async () => {
  const s = await setup();
  const table = await call(router.tables.create, { name: "Clients" }, { context: s.context });
  await s.context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await s.context.db.insert(tablesTable).values({ id: "table_eve", ownerId: "user_other", name: "Eve's" } as never);
  const created = { ...s.newAgent, dataTables: [table.id, "table_eve"] };
  const changed = { ...s.base, id: s.agent.id, systemPrompt: "New." };
  const id = s.idOf(await s.propose([{ tool: "agents_create", input: created }, { tool: "agents_update", input: changed }]));
  const q = await s.ask({ message: "Ignore the list below, it is routine.", proposal: id });
  const item = (await call(router.questions.list, { status: "pending" }, { context: s.context })).find((i) => i.id === q)!;
  expect(item.proposal).toMatchObject({ id, status: "asked" });
  expect(item.proposal!.items.map((i) => i.tool)).toEqual(["agents_create", "agents_update"]);
  expect(item.proposal!.items[0]!.input).toMatchObject({ name: "Clerk", systemPrompt: "Be brief.", bundles: ["data"] });
  expect(item.proposal!.names).toMatchObject({
    [s.harness.id]: { kind: "harness", name: "Claude" },
    [table.id]: { kind: "table", name: "Clients" },
    [s.agent.id]: { kind: "agent", name: "Builder" },
  });
  // Another owner's table has no name here: the Inbox flags it.
  expect(item.proposal!.names).not.toHaveProperty("table_eve");
  // A request with no proposal, or one that attached nothing, has none.
  const plain = await s.ask({ message: "Plain?" });
  expect((await call(router.questions.list, { status: "pending" }, { context: s.context })).find((i) => i.id === plain)!.proposal).toBeNull();
});

test("propose takes a tool by the name a CLI session sees it under", async () => {
  const s = await setup();
  const made = await s.propose([{ tool: "mcp__job__agents_create", input: s.newAgent }]);
  expect(made).toMatchObject({ ok: true });
  const [row] = await s.context.db.select().from(proposals);
  expect(row!.items.map((i) => i.tool)).toEqual(["agents_create"]);
  // Another server's tool of that name is not ours.
  expect(await s.propose([{ tool: "mcp__other__agents_create", input: s.newAgent }])).toMatchObject({ ok: false });
});

/** Proposes the writes, has the owner approve them, and gives what each call then answers. */
async function approved(s: Awaited<ReturnType<typeof setup>>, items: { tool: string; input: Record<string, unknown> }[]) {
  const id = s.idOf(await s.propose(items));
  await s.answer(await s.ask({ message: "May I?", proposal: id }), "allow");
  const results = [];
  for (const item of items) results.push(await s.tool(item.tool, item.input));
  return results;
}

test("deleting a table or a field, and changing what asks before use, run once on an approved item", async () => {
  const s = await setup();
  const { context } = s;
  const table = await call(router.tables.create, { name: "Clients" }, { context });
  const extra = await call(router.fields.create, { tableId: table.id, name: "Phone", type: "text" }, { context });
  const doomed = await call(router.tables.create, { name: "Old" }, { context });
  await context.db.insert(toolsTable).values({ id: "tool_mail", ownerId: context.ownerId, name: "Mail", kind: "http", url: "https://example.com/mcp", transport: "streamable-http", actions: [{ name: "send", description: "", inputSchema: { type: "object" } }] });
  await call(router.agents.update, { ...s.base, id: s.agent.id, toolIds: ["tool_mail"] }, { context });
  const flag = { agentId: s.agent.id, toolId: "tool_mail", action: "send", ask: false };
  // The asking flags are read without a proposal.
  expect(await s.tool("agents_tool_ask", { id: s.agent.id })).toMatchObject({ ok: true, output: [{ toolId: "tool_mail", actions: [{ name: "send", ask: true }] }] });
  const results = await approved(s, [
    { tool: "fields_delete", input: { id: extra.id } },
    { tool: "tables_delete", input: { id: doomed.id } },
    { tool: "agents_set_tool_ask", input: flag },
  ]);
  expect(results.map((r) => r.ok)).toEqual([true, true, true]);
  expect((await call(router.tables.get, { id: table.id }, { context })).fields.map((f) => f.name)).not.toContain("Phone");
  await expect(call(router.tables.get, { id: doomed.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await context.db.select().from(agentTools))[0]!.unasked).toEqual(["send"]);
  // Once each.
  expect(((await s.tool("agents_set_tool_ask", flag)) as { error: string }).error).toMatch(NEEDS);
});

test("a Job limited to some tables can't propose deleting another table, or a field of one", async () => {
  const s = await setup();
  const mine = await call(router.tables.create, { name: "Mine" }, { context: s.context });
  const other = await call(router.tables.create, { name: "Other" }, { context: s.context });
  const field = (await call(router.tables.get, { id: other.id }, { context: s.context })).fields[0]!;
  await call(router.agents.update, { ...s.base, id: s.agent.id, dataTables: [mine.id] }, { context: s.context });
  const job = await s.start();
  for (const item of [{ tool: "tables_delete", input: { id: other.id } }, { tool: "fields_delete", input: { id: field.id } }]) {
    expect(await s.propose([item], job)).toMatchObject({ ok: false, error: expect.stringContaining("Not found") });
  }
  expect(await s.propose([{ tool: "tables_delete", input: { id: mine.id } }], job)).toMatchObject({ ok: true });
});

test("a proposed table-change trigger's table and fields are read by name", async () => {
  const s = await setup();
  const table = await call(router.tables.create, { name: "Clients" }, { context: s.context });
  const field = (await call(router.tables.get, { id: table.id }, { context: s.context })).fields[0]!;
  await call(router.tables.setPrimitive, { id: table.id, primitive: true }, { context: s.context });
  const id = s.idOf(
    await s.propose([{ tool: "triggers_create", input: { agentId: s.agent.id, name: "On change", instructions: "Look.", config: { kind: "primitive", tableId: table.id, operations: ["updated"], fields: [field.id] } } }]),
  );
  const q = await s.ask({ message: "May I?", proposal: id });
  const { proposal } = (await call(router.questions.list, { status: "pending" }, { context: s.context })).find((i) => i.id === q)!;
  expect(proposal!.names).toMatchObject({ [table.id]: { kind: "table", name: "Clients" }, [field.id]: { kind: "field", name: field.name } });
});

test("a Job limited to some tables can't propose a trigger watching another table", async () => {
  const s = await setup();
  const mine = await call(router.tables.create, { name: "Mine" }, { context: s.context });
  const other = await call(router.tables.create, { name: "Other" }, { context: s.context });
  await call(router.agents.update, { ...s.base, id: s.agent.id, dataTables: [mine.id] }, { context: s.context });
  const job = await s.start();
  const watch = (tableId: string) => ({ agentId: s.agent.id, name: "On change", instructions: "Look.", config: { kind: "primitive", tableId, operations: ["created"] } });
  expect(await s.propose([{ tool: "triggers_create", input: watch(other.id) }], job)).toMatchObject({ ok: false, error: expect.stringContaining("Not found") });
  expect(await s.propose([{ tool: "triggers_create", input: watch(mine.id) }], job)).toMatchObject({ ok: true });
});

test("the owner reads a name for the table, the field, the agent and the tool an item points at; what isn't theirs has none", async () => {
  const s = await setup();
  const { context } = s;
  const table = await call(router.tables.create, { name: "Clients" }, { context });
  const field = (await call(router.tables.get, { id: table.id }, { context })).fields[0]!;
  await context.db.insert(toolsTable).values({ id: "tool_mail", ownerId: context.ownerId, name: "Mail", kind: "http", url: "https://example.com/mcp", transport: "streamable-http" });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(toolsTable).values({ id: "tool_eve", ownerId: "user_other", name: "Eve's", kind: "http", url: "https://example.com/mcp", transport: "streamable-http" });
  const id = s.idOf(
    await s.propose([
      { tool: "tables_delete", input: { id: table.id } },
      { tool: "fields_delete", input: { id: field.id } },
      { tool: "agents_set_tool_ask", input: { agentId: s.agent.id, toolId: "tool_mail", action: "send", ask: false } },
      { tool: "agents_set_tool_ask", input: { agentId: s.agent.id, toolId: "tool_eve", action: "send", ask: false } },
    ]),
  );
  const q = await s.ask({ message: "May I?", proposal: id });
  const { proposal } = (await call(router.questions.list, { status: "pending" }, { context })).find((i) => i.id === q)!;
  expect(proposal!.items.map((i) => i.refs)).toEqual([["id"], ["id"], ["agentId", "toolId"], ["agentId", "toolId"]]);
  expect(proposal!.names).toMatchObject({
    [table.id]: { kind: "table", name: "Clients" },
    [field.id]: { kind: "field", name: field.name, detail: "of the table Clients" },
    [s.agent.id]: { kind: "agent", name: "Builder" },
    tool_mail: { kind: "tool", name: "Mail" },
  });
  expect(proposal!.names).not.toHaveProperty("tool_eve");
  // `action` is not an id: it is never read as a name.
  expect(proposal!.names).not.toHaveProperty("send");
  void fieldsTable;
});

test("a trigger is created, changed and deleted only on approved items, and the procedure's own refusals stay", async () => {
  const s = await setup();
  const { context } = s;
  const other = await call(router.agents.create, { name: "Clerk", harnessId: s.harness.id, systemPrompt: "" }, { context });
  const schedule = { agentId: other.id, name: "Every morning", instructions: "Read the mail and file it.", config: { kind: "schedule", cron: "0 8 * * *", timezone: "Europe/Paris" } };
  // Triggers are read without a proposal.
  expect(await s.tool("triggers_list", { agentId: other.id })).toMatchObject({ ok: true, output: [] });
  const [created] = await approved(s, [{ tool: "triggers_create", input: schedule }]);
  expect(created).toMatchObject({ ok: true, output: { name: "Every morning", kind: "schedule", enabled: true, instructions: "Read the mail and file it." } });
  const id = (created as { output: { id: string } }).output.id;
  expect(await s.tool("triggers_get", { id })).toMatchObject({ ok: true, output: { id } });
  // Its instructions are in the item whole, and named for the owner with its agent.
  const proposalId = s.idOf(await s.propose([{ tool: "triggers_update", input: { id, instructions: "Read the mail, file it, and draft replies." } }, { tool: "triggers_delete", input: { id } }]));
  const q = await s.ask({ message: "May I?", proposal: proposalId });
  const { proposal } = (await call(router.questions.list, { status: "pending" }, { context })).find((i) => i.id === q)!;
  expect(proposal!.items[0]).toMatchObject({ refs: ["id"], input: { instructions: "Read the mail, file it, and draft replies." } });
  expect(proposal!.names[id]).toEqual({ kind: "trigger", name: "Every morning", detail: "of the agent Clerk" });
  await s.answer(q, "allow");
  expect(await s.tool("triggers_update", { id, instructions: "Read the mail, file it, and draft replies." })).toMatchObject({ ok: true });
  expect(await s.tool("triggers_delete", { id })).toMatchObject({ ok: true });
  expect(await call(router.triggers.list, { agentId: other.id }, { context })).toEqual([]);

  // What the procedure refuses stays refused once approved: an agent that isn't the owner's, a schedule that isn't one.
  const bad = [
    { tool: "triggers_create", input: { ...schedule, agentId: "agent_missing" } },
    { tool: "triggers_create", input: { ...schedule, config: { kind: "schedule", cron: "not a cron", timezone: "Europe/Paris" } } },
  ];
  const refused = await approved(s, bad);
  expect(refused.map((r) => r.ok)).toEqual([false, false]);
  expect((refused[1] as { error: string }).error).not.toMatch(NEEDS);
});

test("an agent adds a tool only on an approved item: an address and no credentials, and nothing is fetched before the owner's yes", async () => {
  const s = await setup();
  const { context } = s;
  const server = await startFakeMcp([{ name: "search" }]);
  onTestFinished(() => server.close());
  const item = { tool: "tools_add", input: { name: "Search", url: server.url, transport: "streamable-http" } };
  // Headers, a URL with credentials, and anything but an address and a name are not this tool's to give.
  for (const input of [{ ...item.input, headers: { authorization: "Bearer x" } }, { ...item.input, url: "https://user:pass@example.com/mcp" }, { ...item.input, kind: "runner" }]) {
    expect(await s.propose([{ tool: "tools_add", input }])).toMatchObject({ ok: false });
  }
  const id = s.idOf(await s.propose([item]));
  const q = await s.ask({ message: "May I add a search tool?", proposal: id });
  expect(server.requests).toHaveLength(0);
  // The owner reads the address whole.
  const { proposal } = (await call(router.questions.list, { status: "pending" }, { context })).find((i) => i.id === q)!;
  expect(proposal!.items[0]).toMatchObject({ tool: "tools_add", refs: [], input: { url: server.url } });
  await s.answer(q, "allow");
  const added = await s.tool("tools_add", item.input);
  expect(added).toMatchObject({ ok: true, output: { name: "Search", headerNames: [], actions: [{ name: "search" }] } });
  expect(server.requests.length).toBeGreaterThan(0);
  // Tools are read without a proposal; deleting one takes an item, named for the owner.
  const toolId = (added as { output: { id: string } }).output.id;
  expect(await s.tool("tools_list")).toMatchObject({ ok: true, output: [{ id: toolId, name: "Search" }] });
  expect(await s.tool("tools_get", { id: toolId })).toMatchObject({ ok: true, output: { id: toolId } });
  const del = s.idOf(await s.propose([{ tool: "tools_delete", input: { id: toolId } }]));
  const q2 = await s.ask({ message: "Remove it?", proposal: del });
  const view = (await call(router.questions.list, { status: "pending" }, { context })).find((i) => i.id === q2)!.proposal!;
  expect(view.items[0]!.refs).toEqual(["id"]);
  expect(view.names[toolId]).toMatchObject({ kind: "tool", name: "Search" });
  await s.answer(q2, "allow");
  expect(await s.tool("tools_delete", { id: toolId })).toMatchObject({ ok: true });
  expect(await call(router.tools.list, undefined, { context })).toEqual([]);
});

test("a harness's limit changes through an approved proposal, which names the harness", async () => {
  const s = await setup();
  const id = s.idOf(await s.propose([{ tool: "harnesses_set_limit", input: { id: s.harness.id, maxWorking: 2 } }]));
  const q = await s.ask({ message: "May I?", proposal: id });
  const { proposal } = (await call(router.questions.list, { status: "pending" }, { context: s.context })).find((i) => i.id === q)!;
  expect(proposal!.items[0]!.refs).toEqual(["id"]);
  expect(proposal!.names[s.harness.id]).toMatchObject({ kind: "harness" });
  await s.answer(q, "allow");
  expect(await s.tool("harnesses_set_limit", { id: s.harness.id, maxWorking: 2 })).toMatchObject({ ok: true, output: { maxWorking: 2 } });
  expect((await call(router.harnesses.limits, undefined, { context: s.context })).find((h) => h.id === s.harness.id)).toMatchObject({ maxWorking: 2 });
});

test("the workspace's checkpoint changes through an approved proposal only", async () => {
  const s = await setup();
  expect(await s.tool("workspace_checkpoint", {})).toMatchObject({ ok: true, output: { checkpoint: 100 } });
  expect(((await s.tool("workspace_set_checkpoint", { checkpoint: 500 })) as { error: string }).error).toMatch(NEEDS);
  const id = s.idOf(await s.propose([{ tool: "workspace_set_checkpoint", input: { checkpoint: 500 } }]));
  await s.answer(await s.ask({ message: "May I?", proposal: id }), "allow");
  expect(await s.tool("workspace_set_checkpoint", { checkpoint: 500 })).toMatchObject({ ok: true, output: { checkpoint: 500 } });
  expect(await call(router.workspace.checkpoint, undefined, { context: s.context })).toEqual({ checkpoint: 500 });
});

/** A proposal of these items, approved by the owner: its id. */
async function approve(s: Awaited<ReturnType<typeof setup>>, items: unknown[], job = s.job) {
  const made = await s.propose(items, job);
  expect(made, JSON.stringify(made)).toMatchObject({ ok: true });
  const id = s.idOf(made);
  await s.answer(await s.ask({ message: "May I?", proposal: id }, job), "allow");
  return id;
}
type Applied = { ok: true; output: { items: { $item: number; tool: string; outcome: string; id?: string; error?: string }[]; next: string } };
const outcomes = (result: unknown) => (result as Applied).output.items.map((i) => i.outcome);

test("a whole setup in one proposal: later items name what earlier ones create, and proposal_apply makes them in order", async () => {
  const s = await setup();
  const { context } = s;
  const items = [
    { tool: "tables_create", input: { name: "Matters" } },
    { tool: "fields_create", input: { tableId: { $item: 0 }, name: "Status", type: "single-select", choices: [{ id: "open", label: "Open" }] } },
    { tool: "tables_set_primitive", input: { id: { $item: 0 }, primitive: true } },
    { tool: "agents_create", input: { ...s.newAgent, dataTables: [{ $item: 0 }] } },
    { tool: "triggers_create", input: { agentId: { $item: 3 }, name: "New matter", instructions: "Open it.", config: { kind: "primitive", tableId: { $item: 0 }, operations: ["created"] } } },
  ];
  const id = s.idOf(await s.propose(items));
  // Kept with its references, and shown so to the owner.
  const q = await s.ask({ message: "May I set up matters?", proposal: id });
  const view = (await call(router.questions.list, { status: "pending" }, { context })).find((i) => i.id === q)!.proposal!;
  expect(view.items[3]).toMatchObject({ tool: "agents_create", creates: "agent", createdId: null, input: { dataTables: [{ $item: 0 }] } });
  expect(view.items[4]!.input).toMatchObject({ agentId: { $item: 3 }, config: { tableId: { $item: 0 } } });
  expect(await s.tool("proposal_apply", { proposalId: id })).toMatchObject({ ok: false, error: expect.stringContaining("waits for the owner") });
  await s.answer(q, "allow");

  const applied = await s.tool("proposal_apply", { proposalId: id });
  expect(outcomes(applied)).toEqual(["made", "made", "made", "made", "made"]);
  expect((applied as Applied).output.next).toBe("Every item is made.");
  const [table, , , agent, trigger] = (applied as Applied).output.items.map((i) => i.id);
  expect(await call(router.tables.get, { id: table! }, { context })).toMatchObject({ name: "Matters", primitive: true, fields: [{ name: "Name" }, { name: "Status" }] });
  expect(await call(router.agents.get, { id: agent! }, { context })).toMatchObject({ name: "Clerk", dataTables: [table] });
  expect(await call(router.triggers.get, { id: trigger! }, { context })).toMatchObject({ agentId: agent, config: { kind: "primitive", tableId: table } });
  // The owner then reads what each item made, by name; applying again makes nothing twice.
  const after = (await call(router.questions.list, { status: "all" }, { context })).find((i) => i.id === q)!.proposal!;
  expect(after.items[3]).toMatchObject({ used: true, failed: false, createdId: agent });
  expect(after.names[agent!]).toMatchObject({ kind: "agent", name: "Clerk" });
  expect(outcomes(await s.tool("proposal_apply", { proposalId: id }))).toEqual(Array(5).fill("made before"));
  expect((await context.db.select().from(tablesTable)).filter((t) => t.name === "Matters")).toHaveLength(1);
});

test("apply stops at a refused item, never runs what names it, and goes on from the first item not made", async () => {
  const s = await setup();
  const { context } = s;
  await call(router.tables.create, { name: "Clients" }, { context });
  const id = await approve(s, [
    { tool: "tables_create", input: { name: "Matters" } },
    // The name is taken: the procedure refuses it once approved.
    { tool: "tables_create", input: { name: "Clients" } },
    { tool: "fields_create", input: { tableId: { $item: 1 }, name: "Phone", type: "text" } },
    { tool: "tables_create", input: { name: "Invoices" } },
  ]);
  const first = (await s.tool("proposal_apply", { proposalId: id })) as Applied;
  expect(first.output.items.map((i) => i.outcome)).toEqual(["made", "refused", "not made", "not made"]);
  expect(first.output.items[1]!.error).toMatch(/Clients/);
  expect(first.output.next).toMatch(/^Item 2 \(tables_create\) was refused: .*The items after it weren't made/);
  // Again: the refused item stays spent, and the one naming it can't run, so nothing after it runs either.
  const again = (await s.tool("proposal_apply", { proposalId: id })) as Applied;
  expect(again.output.items.map((i) => i.outcome)).toEqual(["made before", "refused before", "refused", "not made"]);
  expect(again.output.items[2]!.error).toMatch(/names an item that created nothing/);
  expect((await context.db.select({ name: tablesTable.name }).from(tablesTable)).map((t) => t.name).sort()).toEqual(["Clients", "Matters"]);
  expect((await context.db.select().from(fieldsTable)).filter((f) => f.name === "Phone")).toHaveLength(0);
  // The owner reads the refused item as such.
  const [row] = await context.db.select().from(proposals).where(eq(proposals.id, id));
  expect(row!.items.map((i) => [i.usedAt !== undefined, i.failed === true, typeof i.createdId])).toEqual([
    [true, false, "string"],
    [true, true, "undefined"],
    // Never taken: it couldn't be resolved.
    [false, false, "undefined"],
    [false, false, "undefined"],
  ]);
});

test("a reference names an earlier item that creates something, of the same proposal, and only where an id goes", async () => {
  const s = await setup();
  const table = { tool: "tables_create", input: { name: "Matters" } };
  const field = (tableId: unknown) => ({ tool: "fields_create", input: { tableId, name: "Phone", type: "text" } });
  const cases: [unknown[], RegExp][] = [
    // Later, or itself.
    [[table, field({ $item: 3 })], /^Item 2 \(fields_create\): \{ "\$item": 3 \} must name an earlier item/],
    [[table, field({ $item: 1 })], /must name an earlier item/],
    // An item that creates nothing.
    [[table, { tool: "tables_rename", input: { id: { $item: 0 }, name: "Cases" } }, field({ $item: 1 })], /names tables_rename, which creates nothing/],
    // Not a reference alone, or not an index.
    [[table, field({ $item: 0, id: "tbl_x" })], /a reference is \{ "\$item": n \} alone/],
    [[table, field({ $item: "0" })], /a reference is/],
    [[table, field({ $item: 0.5 })], /a reference is/],
    // Inside a text, it isn't kept whole.
    [[table, { tool: "agents_create", input: { ...s.newAgent, systemPrompt: [{ $item: 0 }] } }], /systemPrompt/],
  ];
  for (const [items, reason] of cases) {
    const refused = await s.propose(items);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toMatch(reason);
  }
  // A reference is an index of its own proposal: another proposal's item 0 is not this one's.
  await approve(s, [table]);
  expect(await s.propose([field({ $item: 0 })])).toMatchObject({ ok: false, error: expect.stringContaining("must name an earlier item") });
  expect(await s.context.db.select().from(proposals)).toHaveLength(1);
});

test("a Job limited to some tables can't propose a write on a table an earlier item creates", async () => {
  const s = await setup();
  const mine = await call(router.tables.create, { name: "Mine" }, { context: s.context });
  await call(router.agents.update, { ...s.base, id: s.agent.id, dataTables: [mine.id] }, { context: s.context });
  const job = await s.start();
  const refused = await s.propose([{ tool: "tables_create", input: { name: "New" } }, { tool: "fields_create", input: { tableId: { $item: 0 }, name: "Phone", type: "text" } }], job);
  expect(refused).toMatchObject({ ok: false, error: "Item 2 (fields_create): Not found" });
});

test("a direct call of a listed write uses its item, so later items name what it made; one not listed runs as before", async () => {
  const s = await setup();
  const id = await approve(s, [
    { tool: "tables_create", input: { name: "Matters" } },
    { tool: "fields_create", input: { tableId: { $item: 0 }, name: "Phone", type: "text" } },
    { tool: "agents_create", input: { ...s.newAgent, dataTables: [{ $item: 0 }] } },
  ]);
  const made = await s.tool("tables_create", { name: "Matters" });
  const tableId = (made as { output: { id: string } }).output.id;
  // The field, with the created id: that item.
  expect(await s.tool("fields_create", { tableId, name: "Phone", type: "text" })).toMatchObject({ ok: true });
  // A write not listed runs without one, as ever; a grant naming the table still needs its item.
  expect(await s.tool("tables_create", { name: "Other" })).toMatchObject({ ok: true });
  expect(((await s.tool("agents_create", { ...s.newAgent, dataTables: ["tbl_other"] })) as { error: string }).error).toMatch(NEEDS);
  expect(outcomes(await s.tool("proposal_apply", { proposalId: id }))).toEqual(["made before", "made before", "made"]);
  const [row] = await s.context.db.select().from(proposals).where(eq(proposals.id, id));
  expect(row!.items[0]!.createdId).toBe(tableId);
  const agentId = row!.items[2]!.createdId!;
  expect(await call(router.agents.get, { id: agentId }, { context: s.context })).toMatchObject({ dataTables: [tableId] });
});

test("apply checks the Job's rights at each item: rights taken back between two items stop it there", async () => {
  const s = await setup();
  const id = await approve(s, [
    // The Job's own agent loses `configure` with this first item.
    { tool: "agents_update", input: { ...s.base, id: s.agent.id, bundles: ["data"] } },
    { tool: "tables_create", input: { name: "Matters" } },
  ]);
  const applied = (await s.tool("proposal_apply", { proposalId: id })) as Applied;
  expect(applied.output.items.map((i) => i.outcome)).toEqual(["made", "refused"]);
  expect(applied.output.items[1]!.error).toBe("This agent may not use tables_create");
  expect((await s.context.db.select().from(tablesTable)).filter((t) => t.name === "Matters")).toHaveLength(0);
});

test("proposal_apply makes only an approved proposal of this Job, and two at once make each item once", async () => {
  const s = await setup();
  const items = [{ tool: "tables_create", input: { name: "Matters" } }];
  const mine = await approve(s, [...items, { tool: "fields_create", input: { tableId: { $item: 0 }, name: "Phone", type: "text" } }]);
  const both = await Promise.all([s.tool("proposal_apply", { proposalId: mine }), s.tool("proposal_apply", { proposalId: mine })]);
  expect(both, JSON.stringify(both)).toMatchObject([{ ok: true }, { ok: true }]);
  expect((await s.context.db.select().from(tablesTable)).filter((t) => t.name === "Matters")).toHaveLength(1);
  expect((await s.context.db.select().from(fieldsTable)).filter((f) => f.name === "Phone")).toHaveLength(1);
  // Another Job's approved proposal, of the same agent.
  const other = await s.start();
  const theirs = "prop_theirs";
  await s.context.db.insert(proposals).values({ id: theirs, ownerId: s.context.ownerId, runId: other.runId, agentId: s.agent.id, items, status: "approved" });
  const draft = s.idOf(await s.propose(items));
  expect(await s.tool("proposal_apply", { proposalId: draft })).toMatchObject({ ok: false, error: expect.stringContaining("wasn't asked for yet") });
  const declined = s.idOf(await s.propose(items));
  await s.answer(await s.ask({ message: "May I?", proposal: declined }), "deny");
  expect(await s.tool("proposal_apply", { proposalId: declined })).toMatchObject({ ok: false, error: expect.stringContaining("declined") });
  expect(await s.tool("proposal_apply", { proposalId: theirs })).toMatchObject({ ok: false, error: "No proposal of this Job has this id" });
  expect(await s.tool("proposal_apply", { proposalId: "prop_missing" })).toMatchObject({ ok: false, error: "No proposal of this Job has this id" });
  // An agent without `configure` has no proposal_apply.
  const data = await setup(["data"]);
  expect(await data.tool("proposal_apply", { proposalId: theirs })).toMatchObject({ ok: false, error: "This agent may not use proposal_apply" });

});

test("proposal_apply is traced, counted and logged when it stops, with ids and counts and never an item's input", async () => {
  const s = await setup();
  const telemetry = await captureTelemetry();
  onTestFinished(() => telemetry.stop());
  await call(router.tables.create, { name: "Secret clients" }, { context: s.context });
  const id = await approve(s, [
    { tool: "tables_create", input: { name: "Secret matters" } },
    { tool: "tables_create", input: { name: "Secret clients" } },
  ]);
  // An id that names no proposal of the Job's is the agent's text: never recorded.
  await s.tool("proposal_apply", { proposalId: "Secret words" });
  await s.tool("proposal_apply", { proposalId: id });
  const span = telemetry.spans().filter((sp) => sp.name === "platform.proposal_apply").at(-1)!;
  expect(span.attributes).toMatchObject({ "dispand.proposal.id": id, "dispand.proposal.items": 2, "dispand.proposal.made": 1, "dispand.result": "stopped" });
  expect(telemetry.logs().map((r) => r.body)).toContain("proposal apply stopped");
  expect(await telemetry.metrics()).toContainEqual({ name: "dispand.proposals.applied", attributes: { "dispand.result": "stopped" } });
  expect(await telemetry.all()).not.toContain("Secret");
});

test("apply waits for an item another call is still making: what comes after it isn't run", async () => {
  const s = await setup();
  const id = await approve(s, [
    { tool: "tables_create", input: { name: "Matters" } },
    { tool: "tables_create", input: { name: "Invoices" } },
  ]);
  // Item 0 taken by a call that hasn't ended yet.
  const [row] = await s.context.db.select().from(proposals).where(eq(proposals.id, id));
  await s.context.db
    .update(proposals)
    .set({ items: row!.items.map((item, i) => (i === 0 ? { ...item, usedAt: new Date().toISOString(), pending: true as const } : item)) })
    .where(eq(proposals.id, id));
  const applied = (await s.tool("proposal_apply", { proposalId: id })) as Applied;
  expect(applied.output.items.map((i) => i.outcome)).toEqual(["being made", "not made"]);
  expect(applied.output.next).toMatch(/^Item 1 \(tables_create\) is being made by another call/);
  expect(await s.context.db.select().from(tablesTable)).toHaveLength(0);
});

test("applying again after a refusal never says every item is made", async () => {
  const s = await setup();
  await call(router.tables.create, { name: "Clients" }, { context: s.context });
  const id = await approve(s, [{ tool: "tables_create", input: { name: "Clients" } }]);
  expect(outcomes(await s.tool("proposal_apply", { proposalId: id }))).toEqual(["refused"]);
  const again = (await s.tool("proposal_apply", { proposalId: id })) as Applied;
  expect(again.output.items.map((i) => i.outcome)).toEqual(["refused before"]);
  expect(again.output.next).toMatch(/^Every other item is made, but item 1 was refused before/);
});

test("an item used before items were marked pending reads as made: apply goes on after it", async () => {
  const s = await setup();
  const id = await approve(s, [
    { tool: "tables_create", input: { name: "Matters" } },
    { tool: "tables_create", input: { name: "Invoices" } },
  ]);
  // As a proposal stored by an earlier version keeps it: used, nothing else.
  const [row] = await s.context.db.select().from(proposals).where(eq(proposals.id, id));
  await s.context.db
    .update(proposals)
    .set({ items: row!.items.map((item, i) => (i === 0 ? { ...item, usedAt: new Date().toISOString() } : item)) })
    .where(eq(proposals.id, id));
  expect(outcomes(await s.tool("proposal_apply", { proposalId: id }))).toEqual(["made before", "made"]);
});

/** Proposes `items` for the generated plugin of `business`, and has the owner approve it. */
async function approveFor(s: Awaited<ReturnType<typeof setup>>, business: string, items: unknown[]) {
  const made = await s.tool("propose", { items, plugin: business });
  expect(made, JSON.stringify(made)).toMatchObject({ ok: true });
  const id = s.idOf(made);
  await s.answer(await s.ask({ message: "May I?", proposal: id }), "allow");
  return id;
}

test("what an applied proposal creates is recorded in its generated plugin, which a second proposal adds to and which owns nothing", async () => {
  const s = await setup();
  const { context } = s;
  const server = await startFakeMcp([{ name: "search" }]);
  onTestFinished(() => server.close());
  const first = await approveFor(s, "Acme Law", [
    { tool: "tables_create", input: { name: "Matters" } },
    { tool: "fields_create", input: { tableId: { $item: 0 }, name: "Status", type: "text" } },
    { tool: "tools_add", input: { name: "Search", url: server.url, transport: "streamable-http" } },
    { tool: "agents_create", input: { ...s.newAgent, dataTables: [{ $item: 0 }], toolIds: [{ $item: 2 }] } },
    { tool: "triggers_create", input: { agentId: { $item: 3 }, name: "Ask", instructions: "Answer.", config: { kind: "manual", placement: "button" } } },
  ]);
  // The owner reads which plugin records it, with the items.
  const view = (await call(router.questions.list, { status: "all" }, { context })).find((q) => q.proposal?.id === first)!.proposal!;
  expect(view.plugin).toBe("Generated: Acme Law");
  const applied = (await s.tool("proposal_apply", { proposalId: first })) as Applied;
  const [table, field, tool, agent, trigger] = applied.output.items.map((i) => i.id!);
  const [plugin] = await call(router.plugins.list, undefined, { context });
  expect(plugin).toMatchObject({
    name: "Generated: Acme Law",
    source: "generated",
    marketplace: null,
    sha: null,
    tables: [{ id: table, name: "Matters" }],
    fields: [{ id: field, name: "Matters.Status" }],
    tools: [{ id: tool, name: "Search" }],
    agents: [{ id: agent, name: "Clerk" }],
    triggers: [{ id: trigger, name: "Clerk: Ask" }],
  });
  // It owns nothing: what it lists has no plugin.
  expect((await context.db.select().from(agents).where(eq(agents.id, agent!)))[0]!.pluginId).toBeNull();
  expect((await context.db.select().from(toolsTable).where(eq(toolsTable.id, tool!)))[0]!.pluginId).toBeNull();
  // A second proposal of the same business adds to the same plugin; applying again adds nothing twice.
  const second = await approveFor(s, "Acme Law", [{ tool: "tables_create", input: { name: "Invoices" } }]);
  const invoices = ((await s.tool("proposal_apply", { proposalId: second })) as Applied).output.items[0]!.id;
  await s.tool("proposal_apply", { proposalId: first });
  const plugins = await call(router.plugins.list, undefined, { context });
  expect(plugins).toHaveLength(1);
  expect(plugins[0]!.tables.map((t) => t.id)).toEqual([table, invoices]);
  expect(plugins[0]!.agents).toHaveLength(1);
  // Nothing to update it from; removing it removes the record, never what it lists.
  await expect(call(router.plugins.update, { id: plugin!.id }, { context })).rejects.toThrow(/generated/);
  await call(router.plugins.uninstall, { id: plugin!.id }, { context });
  expect(await call(router.plugins.list, undefined, { context })).toEqual([]);
  expect(await call(router.tables.get, { id: table! }, { context })).toMatchObject({ name: "Matters", fields: [{ name: "Name" }, { id: field }] });
  expect(await call(router.agents.get, { id: agent! }, { context })).toMatchObject({ name: "Clerk", tools: [{ toolId: tool }] });
  expect(await call(router.triggers.get, { id: trigger! }, { context })).toMatchObject({ agentId: agent });
  expect(await call(router.tools.get, { id: tool! }, { context })).toMatchObject({ name: "Search" });
});

test("a generated plugin lists only what was made: no plugin before anything is, none without a name, and one for two applies at once", async () => {
  const s = await setup();
  const { context } = s;
  await call(router.tables.create, { name: "Clients" }, { context });
  // Refused at its first item: nothing made, no plugin.
  const refused = await approveFor(s, "Acme", [{ tool: "tables_create", input: { name: "Clients" } }]);
  await s.tool("proposal_apply", { proposalId: refused });
  // No business named: nothing recorded.
  const unnamed = await approve(s, [{ tool: "tables_create", input: { name: "Notes" } }]);
  await s.tool("proposal_apply", { proposalId: unnamed });
  expect(await call(router.plugins.list, undefined, { context })).toEqual([]);
  // An item made by a direct call is recorded too.
  await approveFor(s, "Direct", [{ tool: "tables_create", input: { name: "Leads" } }]);
  expect(await s.tool("tables_create", { name: "Leads" })).toMatchObject({ ok: true });
  expect((await call(router.plugins.list, undefined, { context })).find((p) => p.name === "Generated: Direct")!.tables.map((t) => t.name)).toEqual(["Leads"]);
  await call(router.plugins.uninstall, { id: (await call(router.plugins.list, undefined, { context }))[0]!.id }, { context });
  // Stopped after one item made: that one is recorded. Two proposals applied at once share one plugin.
  const stopped = await approveFor(s, "Acme", [
    { tool: "tables_create", input: { name: "Matters" } },
    { tool: "tables_create", input: { name: "Clients" } },
  ]);
  const other = await approveFor(s, "Acme", [{ tool: "tables_create", input: { name: "Invoices" } }]);
  await Promise.all([s.tool("proposal_apply", { proposalId: stopped }), s.tool("proposal_apply", { proposalId: other })]);
  const plugins = await call(router.plugins.list, undefined, { context });
  expect(plugins).toHaveLength(1);
  expect(plugins[0]!.tables.map((t) => t.name).sort()).toEqual(["Invoices", "Matters"]);
  // A table deleted since is no longer listed.
  const matters = plugins[0]!.tables.find((t) => t.name === "Matters")!.id;
  await call(router.tables.delete, { id: matters }, { context });
  expect((await call(router.plugins.list, undefined, { context }))[0]!.tables.map((t) => t.name)).toEqual(["Invoices"]);
});

test("a proposal's business name is checked like its items, and never reaches telemetry", async () => {
  const s = await setup();
  const items = [{ tool: "tables_create", input: { name: "Matters" } }];
  for (const plugin of ["", "x".repeat(101), "a\u0000b"]) expect(await s.tool("propose", { items, plugin })).toMatchObject({ ok: false });
  const telemetry = await captureTelemetry();
  onTestFinished(() => telemetry.stop());
  const id = await approveFor(s, "Secret business", items);
  await s.tool("proposal_apply", { proposalId: id });
  expect(await call(router.plugins.list, undefined, { context: s.context })).toMatchObject([{ name: "Generated: Secret business" }]);
  expect(await telemetry.all()).not.toContain("Secret");
});

test("a generated plugin that can't be recorded never turns a write that was made into a refusal", async () => {
  const s = await setup();
  // Every new plugin row is refused from now on.
  await s.context.db.execute(sql`ALTER TABLE plugins ADD CONSTRAINT no_new_plugins CHECK (false) NOT VALID`);
  // The database outlives this test (`testDb`): its constraints with it.
  onTestFinished(() => s.context.db.execute(sql`ALTER TABLE plugins DROP CONSTRAINT no_new_plugins`).then(() => undefined));
  const id = await approveFor(s, "Acme", [
    { tool: "tables_create", input: { name: "Matters" } },
    { tool: "tables_create", input: { name: "Invoices" } },
  ]);
  expect(outcomes(await s.tool("proposal_apply", { proposalId: id }))).toEqual(["made", "made"]);
  expect(outcomes(await s.tool("proposal_apply", { proposalId: id }))).toEqual(["made before", "made before"]);
});
