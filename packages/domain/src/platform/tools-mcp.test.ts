import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { questions, runs, stepRuns, tools as toolsTable } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { startFakeMcp, type FakeMcp } from "../tools/test-server.ts";
import { jobTokenOf } from "./token.ts";
import { handleJobToolsMcp } from "./tools-mcp.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const SECRET = "Bearer s3cret-value";

/** A CLI agent with the HTTP tool "GitHub", a Job of it still going, and an MCP client on the tools endpoint with the Job's token. */
async function setup(withTool = true) {
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
  const agent = await call(router.agents.create, { ...fields, toolIds: withTool ? [tool.id] : [] }, { context });
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

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const NEEDS = /needs the owner's approval/;

test("lists the agent's HTTP tools' actions and runs an approved call, with the secret reaching only the tool", async () => {
  const s = await setup();
  const { tools } = await s.client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["GitHub_create_issue", "GitHub_list_issues"]);
  expect(tools.find((t) => t.name === "GitHub_create_issue")).toMatchObject({ description: "Create an issue", inputSchema: { required: ["title"] } });
  await s.approve("mcp__job_tools__GitHub_create_issue", { title: "Bug" });
  const result = await s.client.callTool({ name: "GitHub_create_issue", arguments: { title: "Bug" } });
  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toBe("created #1");
  expect(s.calls).toEqual([["create_issue", { title: "Bug" }]]);
  expect(s.server.requests.some((h) => h.authorization === SECRET)).toBe(true);
  expect(JSON.stringify(tools)).not.toContain("s3cret");
});

test("refuses a call nobody approved, a denied one, and one whose arguments changed", async () => {
  const s = await setup();
  const refused = async (args: Record<string, unknown>) => {
    const result = await s.client.callTool({ name: "GitHub_create_issue", arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(NEEDS);
  };
  await refused({ title: "Bug" });
  await s.approve("mcp__job_tools__GitHub_create_issue", { title: "Bug" }, "deny");
  await refused({ title: "Bug" });
  await s.approve("mcp__job_tools__GitHub_create_issue", { title: "Bug" });
  await refused({ title: "Another" });
  // An approval for Dispand's own server, or for another action, is not this call's.
  await s.approve("mcp__job__GitHub_create_issue", { title: "Other" });
  await s.approve("mcp__job_tools__GitHub_list_issues", { title: "Other" });
  await refused({ title: "Other" });
  expect(s.calls).toEqual([]);
});

test("an approval runs one call", async () => {
  const s = await setup();
  await s.approve("mcp__job_tools__GitHub_list_issues", {});
  expect((await s.client.callTool({ name: "GitHub_list_issues", arguments: {} })).isError).toBeFalsy();
  const again = await s.client.callTool({ name: "GitHub_list_issues", arguments: {} });
  expect(again.isError).toBe(true);
  expect(textOf(again)).toMatch(NEEDS);
  expect(s.calls).toHaveLength(1);
});

test("a tool taken back, or an action gone, is refused and the approval is kept", async () => {
  const s = await setup();
  const id = await s.approve("mcp__job_tools__GitHub_create_issue", { title: "Bug" });
  await s.context.db.update(toolsTable).set({ actions: [] }).where(eq(toolsTable.id, s.tool.id));
  const gone = await s.client.callTool({ name: "GitHub_create_issue", arguments: { title: "Bug" } }).catch((err: unknown) => ({ isError: true, content: [{ text: String(err) }] }));
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
