import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { agents, agentTools, fields as fieldsTable, proposals, questions, stepRuns, tables as tablesTable, tools as toolsTable, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { startFakeMcp } from "../tools/test-server.ts";
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
    // The refusal names what can be proposed, so the agent finds its way.
    [[{ tool: "agents_delete", input: {} }], /agents_delete is not a write you can propose.*agents_create.*tables_delete/],
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
  expect(grants.map((t) => t.name).sort()).toEqual(["agents_create", "agents_set_tool_ask", "agents_update", "fields_delete", "harnesses_set_limit", "tables_delete", "tools_add", "tools_delete", "triggers_create", "triggers_delete", "triggers_update"]);
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
    tools_delete: { id: "tool_x" },
    harnesses_set_limit: { id: s.agent.harnessId, maxWorking: 10 },
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
