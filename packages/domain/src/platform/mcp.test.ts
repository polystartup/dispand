import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { runs } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { handleJobMcp } from "./mcp.ts";
import { handleJobToolsMcp } from "./tools-mcp.ts";
import { jobTokenOf } from "./token.ts";

type Ctx = Awaited<ReturnType<typeof ownerContext>>;

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const job = async (tableName: string) => {
    const table = await call(router.tables.create, { name: tableName }, { context });
    const agent = await call(router.agents.create, { name: `Clerk of ${tableName}`, harnessId: harness.id, systemPrompt: "", bundles: ["data"], dataTables: [table.id] }, { context });
    const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
    return { table, agent, runId, token: jobTokenOf(context.secrets, run!)! };
  };
  return { context, job };
}

/** An MCP client whose requests go straight to the handler. */
async function connect(context: Ctx, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://dispand.test/mcp/job"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => handleJobMcp(new Request(input as string | URL, init as RequestInit), context),
  });
  await client.connect(transport);
  onTestFinished(() => client.close());
  return client;
}

const post = (context: Ctx, headers: Record<string, string>) =>
  handleJobMcp(
    new Request("https://dispand.test/mcp/job", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    context,
  );

const textOf = (result: unknown) => ((result as { content: { type: string; text: string }[] }).content[0]!.text);

test("the endpoint lists the Job's tools and runs one", async () => {
  const { context, job } = await setup();
  const { table, token } = await job("Clients");
  const client = await connect(context, token);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["rows_create", "rows_delete", "rows_get", "rows_list", "rows_update", "tables_get", "tables_list"]);
  expect(tools.find((t) => t.name === "rows_create")).toMatchObject({ description: expect.stringContaining("row"), inputSchema: { type: "object" } });
  const created = await client.callTool({ name: "rows_create", arguments: { tableId: table.id } });
  expect(created.isError).toBeFalsy();
  expect(JSON.parse(textOf(created))).toMatchObject({ id: expect.stringMatching(/^row_/) });
  expect((await call(router.rows.list, { tableId: table.id }, { context })).rows).toHaveLength(1);
});

test("no token, a wrong token and an ended Job's token get 401 with a Bearer challenge", async () => {
  const { context, job } = await setup();
  const { runId, token } = await job("Clients");
  expect((await post(context, { authorization: `Bearer ${token}` })).status).toBe(200);
  for (const headers of [{}, { authorization: "Bearer dj_wrong" }, { authorization: token }, { authorization: `Basic ${token}` }]) {
    const res = await post(context, headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res.text()).not.toContain(token);
  }
  await context.engine.stopRun(runId);
  expect((await post(context, { authorization: `Bearer ${token}` })).status).toBe(401);
});

test("a refusal comes back as a tool error, never as a transport error or a stack", async () => {
  const { context, job } = await setup();
  const mine = await job("Clients");
  const theirs = await job("Matters");
  const client = await connect(context, mine.token);
  const refused = await client.callTool({ name: "rows_list", arguments: { tableId: theirs.table.id } });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toBe("Not found");
  // A tool the Job doesn't have isn't listed, and calling it by name is refused.
  const unknown = await client.callTool({ name: "tables_create", arguments: { name: "X" } }).catch((err: unknown) => err);
  expect(JSON.stringify(unknown instanceof Error ? unknown.message : unknown)).not.toMatch(/at .*\.ts/);
  expect((await call(router.tables.list, undefined, { context })).map((t) => t.name).sort()).toEqual(["Clients", "Matters"]);
});

test("one Job's token never reaches another Job's tables", async () => {
  const { context, job } = await setup();
  const a = await job("Clients");
  const b = await job("Matters");
  const client = await connect(context, a.token);
  expect(JSON.parse(textOf(await client.callTool({ name: "tables_list", arguments: {} })))).toMatchObject([{ id: a.table.id }]);
  expect((await client.callTool({ name: "rows_create", arguments: { tableId: b.table.id } })).isError).toBe(true);
  expect((await call(router.rows.list, { tableId: b.table.id }, { context })).rows).toEqual([]);
});

test("a Job whose agent has no bundle lists no tool, without an error", async () => {
  const { context, job } = await setup();
  const { agent, token } = await job("Clients");
  await call(router.agents.update, { name: agent.name, harnessId: agent.harnessId, systemPrompt: "", id: agent.id, bundles: [] }, { context });
  const client = await connect(context, token);
  expect((await client.listTools()).tools).toEqual([]);
});

test("the endpoints are built once per app, not once per request", async () => {
  const { context, job } = await setup();
  const { token } = await job("Clients");
  const built = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => built.mockRestore());
  for (let i = 0; i < 3; i++) {
    expect((await post(context, { authorization: `Bearer ${token}` })).status).toBe(200);
    const res = await handleJobToolsMcp(
      new Request("https://dispand.test/mcp/job/tools", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      context,
    );
    expect(res.status).toBe(200);
  }
  // The SDK says once, when a handler is built, that JSON responses drop notifications: at most once per endpoint.
  expect(built.mock.calls.filter((c) => String(c[0]).includes("responseMode")).length).toBeLessThanOrEqual(2);
});

test("both endpoints tell the session what to do when Dispand restarts under it", async () => {
  const { context, job } = await setup();
  const { token } = await job("Clients");
  const client = await connect(context, token);
  expect(client.getInstructions()).toMatch(/restart/i);
  expect(client.getInstructions()).toMatch(/wait/i);
  const tools = new Client({ name: "test", version: "1.0.0" });
  await tools.connect(
    new StreamableHTTPClientTransport(new URL("https://dispand.test/mcp/job/tools"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (input, init) => handleJobToolsMcp(new Request(input as string | URL, init as RequestInit), context),
    }),
  );
  onTestFinished(() => tools.close());
  expect(tools.getInstructions()).toMatch(/restart/i);
});
