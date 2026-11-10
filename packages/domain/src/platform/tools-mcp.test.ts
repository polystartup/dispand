import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { questions, runs, stepRuns, tools as toolsTable } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { startFakeMcp, type FakeMcp } from "../tools/test-server.ts";
import { jobTokenOf } from "./token.ts";
import { exposedName } from "./exposed.ts";
import { handleJobToolsMcp } from "./tools-mcp.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const SECRET = "Bearer s3cret-value";

/** A CLI agent with the HTTP tool "GitHub", a Job of it still going, and an MCP client on the tools endpoint with the Job's token. */
async function setup(withTool = true, extraTools: (context: Awaited<ReturnType<typeof ownerContext>>) => Promise<string[]> = async () => []) {
  const context = await ownerContext();
  const calls: [string, Record<string, unknown>][] = [];
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const server = await startFakeMcp([
    { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, call: (args) => (calls.push(["create_issue", args]), text("created #1")) },
    { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: {} }, call: (args) => (calls.push(["list_issues", args]), text("[]")) },
  ]);
  servers.push(server);
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const tool = await call(router.tools.create, { name: "GitHub", url: server.url, transport: "streamable-http", headers: { Authorization: SECRET } }, { context });
  const fields = { name: "Clerk", harnessId: harness.id, systemPrompt: "" };
  const agent = await call(router.agents.create, { ...fields, toolIds: [...(withTool ? [tool.id] : []), ...(await extraTools(context))] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  const token = jobTokenOf(context.secrets, run!)!;
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  let seq = 0;
  /** The session asks permission for a call, as the runner does before an MCP tool, and the owner answers. */
  const approve = async (toolName: string, input: Record<string, unknown>, decision: "allow" | "deny" = "allow") => {
    const n = ++seq;
    await context.engine.onHarnessEvent(step!.sessionId!, { type: "question", questionId: `rq_${n}`, payload: { kind: "permission", toolName, input, canAlwaysAllow: false } }, { runnerId, seq: n });
    const [q] = await context.db.select().from(questions).where(eq(questions.runnerQuestionId, `rq_${n}`));
    await call(router.questions.answer, { questionId: q!.id, answer: { kind: "permission", decision } }, { context });
    return q!.id;
  };
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://dispand.test/mcp/job/tools"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (input, init) => handleJobToolsMcp(new Request(input as string | URL, init as RequestInit), context),
    }),
  );
  onTestFinished(() => client.close());
  return { context, server, calls, tool, agent, fields, runId, token, approve, client };
}

/** The exposed name of an action: its readable part, then a mark of the tool and action it stands for. */
const named = async (client: Client, readable: string) => (await client.listTools()).tools.find((t) => t.name.startsWith(`${readable}_`))!.name;

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const NEEDS = /needs the owner's approval/;

test("lists the agent's HTTP tools' actions and runs an approved call, with the secret reaching only the tool", async () => {
  const s = await setup();
  const { tools } = await s.client.listTools();
  expect(tools.map((t) => t.name.replace(/_[0-9a-f]{16}$/, "")).sort()).toEqual(["github_create_issue", "github_list_issues"]);
  for (const t of tools) expect(t.name).toMatch(/^[a-z0-9_-]{1,64}$/);
  const create = await named(s.client, "github_create_issue");
  expect(tools.find((t) => t.name === create)).toMatchObject({ description: "Create an issue", inputSchema: { required: ["title"] } });
  await s.approve(`mcp__job_tools__${create}`, { title: "Bug" });
  const result = await s.client.callTool({ name: create, arguments: { title: "Bug" } });
  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toBe("created #1");
  expect(s.calls).toEqual([["create_issue", { title: "Bug" }]]);
  expect(s.server.requests.some((h) => h.authorization === SECRET)).toBe(true);
  expect(JSON.stringify(tools)).not.toContain("s3cret");
});

test("refuses a call nobody approved, a denied one, and one whose arguments changed", async () => {
  const s = await setup();
  const create = await named(s.client, "github_create_issue");
  const list = await named(s.client, "github_list_issues");
  const refused = async (args: Record<string, unknown>) => {
    const result = await s.client.callTool({ name: create, arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(NEEDS);
  };
  await refused({ title: "Bug" });
  await s.approve(`mcp__job_tools__${create}`, { title: "Bug" }, "deny");
  await refused({ title: "Bug" });
  await s.approve(`mcp__job_tools__${create}`, { title: "Bug" });
  await refused({ title: "Another" });
  // An approval for Dispand's own server, or for another action, is not this call's.
  await s.approve(`mcp__job__${create}`, { title: "Other" });
  await s.approve(`mcp__job_tools__${list}`, { title: "Other" });
  await refused({ title: "Other" });
  expect(s.calls).toEqual([]);
});

test("an approval runs one call", async () => {
  const s = await setup();
  const list = await named(s.client, "github_list_issues");
  await s.approve(`mcp__job_tools__${list}`, {});
  expect((await s.client.callTool({ name: list, arguments: {} })).isError).toBeFalsy();
  const again = await s.client.callTool({ name: list, arguments: {} });
  expect(again.isError).toBe(true);
  expect(textOf(again)).toMatch(NEEDS);
  expect(s.calls).toHaveLength(1);
});

test("a tool taken back, or an action gone, is refused and the approval is kept", async () => {
  const s = await setup();
  const create = await named(s.client, "github_create_issue");
  const id = await s.approve(`mcp__job_tools__${create}`, { title: "Bug" });
  await s.context.db.update(toolsTable).set({ actions: [] }).where(eq(toolsTable.id, s.tool.id));
  const gone = await s.client.callTool({ name: create, arguments: { title: "Bug" } }).catch((err: unknown) => ({ isError: true, content: [{ text: String(err) }] }));
  expect(gone.isError).toBe(true);
  await call(router.agents.update, { ...s.fields, id: s.agent.id, toolIds: [] }, { context: s.context });
  expect((await s.client.listTools()).tools).toEqual([]);
  expect(s.calls).toEqual([]);
  const [q] = await s.context.db.select().from(questions).where(eq(questions.id, id));
  expect(q!.consumedAt).toBeNull();
});

test("401 without a Job's token, and after the Job ended; a Job with no HTTP tool lists nothing", async () => {
  const s = await setup(false);
  expect((await s.client.listTools()).tools).toEqual([]);
  const post = (headers: Record<string, string>) =>
    handleJobToolsMcp(
      new Request("https://dispand.test/mcp/job/tools", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      s.context,
    );
  expect((await post({})).status).toBe(401);
  expect((await post({ authorization: "Bearer dj_wrong" })).status).toBe(401);
  expect((await post({ authorization: `Bearer ${s.token}` })).status).toBe(200);
  await s.context.engine.stopRun(s.runId);
  expect((await post({ authorization: `Bearer ${s.token}` })).status).toBe(401);
});

test("a name stands for one tool and one action for good: an approval never moves to another that looks alike", async () => {
  // A second tool whose name and action read the same once written as a tool name.
  const other: string[] = [];
  const twin = await startFakeMcp([{ name: "create.issue", description: "Theirs", inputSchema: { type: "object", properties: {} }, call: () => (other.push("called"), { content: [{ type: "text", text: "theirs" }] }) }]);
  servers.push(twin);
  let secondId = "";
  const s = await setup(true, async (context) => {
    secondId = (await call(router.tools.create, { name: "GitHub!", url: twin.url, transport: "streamable-http", headers: {} }, { context })).id;
    return [secondId];
  });
  const before = (await s.client.listTools()).tools;
  const alike = before.filter((t) => t.name.startsWith("github_create_issue_"));
  expect(alike).toHaveLength(2);
  const ours = alike.find((t) => t.description === "Create an issue")!.name;
  const theirs = alike.find((t) => t.description === "Theirs")!.name;
  await s.approve(`mcp__job_tools__${ours}`, { title: "Bug" });
  // The approved tool is taken back: the other's name doesn't change, and nothing takes the first one's.
  await call(router.agents.update, { ...s.fields, id: s.agent.id, toolIds: [secondId] }, { context: s.context });
  expect((await s.client.listTools()).tools.map((t) => t.name)).toEqual([theirs]);
  for (const name of [ours, theirs]) {
    const result = await s.client.callTool({ name, arguments: { title: "Bug" } }).catch(() => ({ isError: true }));
    expect(result.isError).toBe(true);
  }
  expect(s.calls).toEqual([]);
  expect(other).toEqual([]);
});

test("a tool's schema is shown as it is and never compiled: an odd one can't break the endpoint", async () => {
  const s = await setup();
  const odd = { type: "object", $async: true, required: ["title"], properties: { title: { type: "string" } } };
  await s.context.db.update(toolsTable).set({ actions: [{ name: "odd", description: "Odd", inputSchema: odd }] }).where(eq(toolsTable.id, s.tool.id));
  const name = await named(s.client, "github_odd");
  expect((await s.client.listTools()).tools.find((t) => t.name === name)!.inputSchema).toMatchObject({ $async: true, required: ["title"] });
  // Not approved: refused in words, and the endpoint still answers afterwards.
  const result = await s.client.callTool({ name, arguments: {} });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatch(NEEDS);
  expect((await s.client.listTools()).tools).toHaveLength(1);
});

test("two actions never share a name, however alike they read", () => {
  const tool = { id: "tool_01J00000000000000000000000", name: "GitHub" };
  const a = exposedName(tool, "create_issue_in_repository_with_a_long_common_prefix_15389");
  const b = exposedName(tool, "create_issue_in_repository_with_a_long_common_prefix_28192");
  expect(a).not.toBe(b);
  for (const name of [a, b, exposedName(tool, "x"), exposedName({ id: "t", name: "é" }, "!")]) expect(name).toMatch(/^[a-z0-9_-]{1,64}_?[0-9a-f]{16}$|^[a-z0-9_-]{1,64}$/);
  // A CLI names it `mcp__job_tools__<name>`, and a model's tool name holds at most 64 characters.
  expect(`mcp__job_tools__${a}`.length).toBeLessThanOrEqual(64);
  // The same tool and action always give the same name; another tool's same action doesn't.
  expect(exposedName(tool, "x")).toBe(exposedName({ ...tool, name: "GitHub" }, "x"));
  expect(exposedName(tool, "x")).not.toBe(exposedName({ id: "tool_other", name: "GitHub" }, "x"));
});

test("the owner is told which tool and action a call is for, whatever the name it is asked under", async () => {
  const s = await setup();
  const create = await named(s.client, "github_create_issue");
  await s.approve(`mcp__job_tools__${create}`, { title: "Bug" }, "deny");
  const [item] = await call(router.questions.list, { status: "all" }, { context: s.context });
  expect(item!.about).toEqual({ tool: "GitHub", action: "create_issue", description: "Create an issue" });
  // The run's own view of the question (a chat shows it from there) says it too.
  const { questions: asked } = await call(router.runs.get, { runId: s.runId }, { context: s.context });
  expect(asked[0]!.about).toEqual({ tool: "GitHub", action: "create_issue", description: "Create an issue" });
  // Any other permission has nothing to add; a name that stands for nothing either.
  await s.approve("Bash", { command: "ls" }, "deny");
  await s.approve("mcp__job_tools__nothing_0000000000000000", {}, "deny");
  const all = await call(router.questions.list, { status: "all" }, { context: s.context });
  expect(all.map((q) => q.about).filter(Boolean)).toHaveLength(1);
});

test("a long tool name never hides the action from the owner", async () => {
  const s = await setup();
  await s.context.db.update(toolsTable).set({ name: "Acme Customer Relationship Manager", actions: [
    { name: "list_contacts", description: "List", inputSchema: { type: "object" } },
    { name: "delete_all_contacts", description: "Delete everything", inputSchema: { type: "object" } },
  ] }).where(eq(toolsTable.id, s.tool.id));
  const names = (await s.client.listTools()).tools.map((t) => t.name);
  expect(names).toHaveLength(2);
  await s.approve(`mcp__job_tools__${names[1]}`, {}, "deny");
  const [item] = await call(router.questions.list, { status: "all" }, { context: s.context });
  expect(item!.about).toMatchObject({ tool: "Acme Customer Relationship Manager", action: expect.stringMatching(/^(list_contacts|delete_all_contacts)$/) });
  expect(new Set(names).size).toBe(2);
});

test("an action the owner took off the asking ones runs with no approval, until the owner puts it back", async () => {
  const s = await setup();
  const list = await named(s.client, "github_list_issues");
  const create = await named(s.client, "github_create_issue");
  const ask = (action: string, value: boolean) => call(router.agents.setToolAsk, { agentId: s.agent.id, toolId: s.tool.id, action, ask: value }, { context: s.context });
  // An approval given earlier isn't used up by a call that needs none.
  await s.approve(`mcp__job_tools__${list}`, {});
  await ask("list_issues", false);
  expect(textOf(await s.client.callTool({ name: list, arguments: {} }))).toBe("[]");
  expect(textOf(await s.client.callTool({ name: list, arguments: {} }))).toBe("[]");
  // The other action still asks.
  expect(textOf(await s.client.callTool({ name: create, arguments: { title: "Bug" } }))).toMatch(NEEDS);
  // Put back while the Job runs: asked again from the next call on (the earlier approval runs one).
  await ask("list_issues", true);
  expect(textOf(await s.client.callTool({ name: list, arguments: {} }))).toBe("[]");
  expect(textOf(await s.client.callTool({ name: list, arguments: {} }))).toMatch(NEEDS);
  expect(s.calls).toEqual([["list_issues", {}], ["list_issues", {}], ["list_issues", {}]]);
});
