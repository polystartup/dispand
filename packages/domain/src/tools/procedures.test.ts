import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { runners, tools, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { toolTarget } from "./procedures.ts";
import { startFakeMcp, type FakeAction, type FakeMcp } from "./test-server.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const echo: FakeAction = {
  name: "echo",
  description: "Says it back",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  call: (args) => ({ content: [{ type: "text", text: String(args.text) }] }),
};

async function fake(actions: FakeAction[] = [echo]) {
  const server = await startFakeMcp(actions);
  servers.push(server);
  return server;
}

const SECRET = "Bearer s3cret-value";

test("create lists the server's actions, and the header reaches the server", async () => {
  const context = await ownerContext();
  const server = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: { Authorization: SECRET } }, { context });
  expect(tool).toMatchObject({
    id: expect.stringMatching(/^tool_/),
    name: "Echo",
    kind: "http",
    url: server.url,
    transport: "streamable-http",
    headerNames: ["authorization"],
    actions: [{ name: "echo", description: "Says it back", inputSchema: echo.inputSchema }],
    actionsError: null,
    refreshedAt: expect.any(Date),
  });
  expect(server.requests.every((h) => h.authorization === SECRET)).toBe(true);
  const [row] = await context.db.select().from(tools).where(eq(tools.id, tool.id));
  expect(JSON.stringify(row)).not.toContain("s3cret");
  expect(toolTarget(row!, context.secrets).headers).toEqual({ authorization: SECRET });
});

test("header values never in outputs", async () => {
  const context = await ownerContext();
  const server = await fake();
  const created = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: { authorization: SECRET } }, { context });
  const outputs = [
    created,
    await call(router.tools.get, { id: created.id }, { context }),
    await call(router.tools.list, undefined, { context }),
    await call(router.tools.refresh, { id: created.id }, { context }),
    await call(router.tools.update, { id: created.id, name: "Renamed", headers: { "x-other": "s3cret-two" } }, { context }),
  ];
  for (const output of outputs) {
    const json = JSON.stringify(output);
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain("v1.");
  }
  expect(outputs.at(-1)).toMatchObject({ headerNames: ["authorization", "x-other"] });
});

test("an unreachable server stores actionsError Couldn't reach <host>, without a stack or the header", async () => {
  const context = await ownerContext();
  const server = await fake();
  await server.close();
  const tool = await call(router.tools.create, { name: "Gone", url: server.url, transport: "streamable-http", headers: { authorization: SECRET } }, { context });
  expect(tool.actions).toEqual([]);
  expect(tool.actionsError).toBe(`Couldn't reach ${new URL(server.url).host}`);
});

test("refresh keeps the last actions when the server is gone", async () => {
  const context = await ownerContext();
  const server = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: {} }, { context });
  await server.close();
  const refreshed = await call(router.tools.refresh, { id: tool.id }, { context });
  expect(refreshed.actions).toEqual(tool.actions);
  expect(refreshed.actionsError).toMatch(/^Couldn't reach/);
  expect(refreshed.refreshedAt).toEqual(tool.refreshedAt);
});

test("update: at the same address an omitted header is kept and an empty one removed", async () => {
  const context = await ownerContext();
  const first = await fake();
  const tool = await call(
    router.tools.create,
    { name: "Echo", url: first.url, transport: "streamable-http", headers: { authorization: SECRET, "x-team": "a" } },
    { context },
  );
  // Another path of the same origin: the same server, the headers stay.
  const updated = await call(router.tools.update, { id: tool.id, url: `${first.url}?v=2`, headers: { "x-team": "" } }, { context });
  expect(updated.headerNames).toEqual(["authorization"]);
  expect(first.requests.at(-1)).toMatchObject({ authorization: SECRET });
  expect(first.requests.at(-1)!["x-team"]).toBeUndefined();
});

test("a tool's headers never follow it to another address: a new origin starts without them", async () => {
  const context = await ownerContext();
  const first = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: first.url, transport: "streamable-http", headers: { authorization: SECRET, "x-team": "a" } }, { context });
  // Another origin: nothing the owner entered for the first server reaches the second.
  const second = await fake([{ name: "other" }]);
  const moved = await call(router.tools.update, { id: tool.id, url: second.url }, { context });
  expect(moved.headerNames).toEqual([]);
  expect(moved.actions.map((a) => a.name)).toEqual(["other"]);
  expect(second.requests.length).toBeGreaterThan(0);
  expect(second.requests.every((h) => h.authorization === undefined && h["x-team"] === undefined)).toBe(true);
  // Headers given with the move are for the new address: those are kept, and only those.
  const third = await fake();
  const again = await call(router.tools.update, { id: tool.id, url: third.url, headers: { authorization: "Bearer other" } }, { context });
  expect(again.headerNames).toEqual(["authorization"]);
  expect(third.requests.every((h) => h.authorization === "Bearer other")).toBe(true);
});

test("headers go only to https, or plain http on this machine; no credentials in the URL", async () => {
  const context = await ownerContext();
  await expect(
    call(router.tools.create, { name: "A", url: "http://example.com/mcp", transport: "streamable-http", headers: { authorization: SECRET } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Headers are only sent to an https:// URL" });
  await expect(
    call(router.tools.create, { name: "B", url: "https://u:p@example.com/mcp", transport: "streamable-http", headers: {} }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Put credentials in a header, not in the URL" });
  await expect(
    call(router.tools.create, { name: "C", url: "https://example.com/mcp", transport: "streamable-http", headers: { "x-a": "1\r\nx-b: 2" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    call(router.tools.create, { name: "D", url: "https://example.com/mcp", transport: "streamable-http", headers: { "X-A": "1", "x-a": "2" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The header x-a is given twice" });
  expect(await call(router.tools.list, undefined, { context })).toEqual([]);
});

test("names are unique per owner, whatever the case", async () => {
  const context = await ownerContext();
  const server = await fake();
  await call(router.tools.create, { name: "GitHub", url: server.url, transport: "streamable-http", headers: {} }, { context });
  await expect(call(router.tools.create, { name: "github", url: server.url, transport: "streamable-http", headers: {} }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
  });
});

test("another owner's tool is NOT_FOUND, and delete removes the tool", async () => {
  const context = await ownerContext();
  const server = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: {} }, { context });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.update(tools).set({ ownerId: "user_other" }).where(eq(tools.id, tool.id));
  await expect(call(router.tools.get, { id: tool.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.tools.refresh, { id: tool.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.tools.update, { id: tool.id, name: "Mine" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.tools.delete, { id: tool.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await context.db.update(tools).set({ ownerId: context.ownerId }).where(eq(tools.id, tool.id));
  await call(router.tools.delete, { id: tool.id }, { context });
  expect(await call(router.tools.list, undefined, { context })).toEqual([]);
});

/** A runner of the owner, as if it had said hello reporting `reported` MCP servers. */
async function runnerWith(context: Awaited<ReturnType<typeof ownerContext>>, reported: string[]) {
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  await context.db.update(runners).set({ tools: reported }).where(eq(runners.id, runnerId));
  return runnerId;
}

test("a runner tool the runner doesn't report is refused", async () => {
  const context = await ownerContext();
  const runnerId = await runnerWith(context, ["brave-search"]);
  await expect(call(router.tools.create, { kind: "runner", name: "Fetch", runnerId, runnerTool: "fetch" }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "The runner doesn't report an MCP server named fetch: add it to the runner's config.json, then restart the runner",
  });
  await expect(call(router.tools.create, { kind: "runner", name: "Fetch", runnerId: "runner_unknown", runnerTool: "fetch" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await context.db.select().from(tools)).toEqual([]);
});

test("a runner tool lists its actions through its runner; an offline runner gives actionsError “runner offline”", async () => {
  const context = await ownerContext();
  const runnerId = await runnerWith(context, ["fetch"]);
  const offline = await call(router.tools.create, { kind: "runner", name: "Fetch", runnerId, runnerTool: "fetch" }, { context });
  expect(offline).toMatchObject({ kind: "runner", url: null, transport: null, runnerId, runnerTool: "fetch", headerNames: [], actions: [], actionsError: "runner offline" });

  const asked: unknown[] = [];
  context.hub.request = async (id, msg) => {
    asked.push([id, msg]);
    return { type: "tool.discovered", requestId: msg.requestId, actions: [{ name: "fetch", description: "Fetches a URL", inputSchema: { type: "object" } }] };
  };
  const listed = await call(router.tools.refresh, { id: offline.id }, { context });
  expect(asked).toEqual([[runnerId, { type: "tool.discover", requestId: expect.stringMatching(/^req_/), tool: "fetch" }]]);
  expect(listed).toMatchObject({ actions: [{ name: "fetch" }], actionsError: null, refreshedAt: expect.any(Date) });

  // The runner's own reason, and the last actions stay.
  context.hub.request = async (_id, msg) => ({ type: "tool.discovered", requestId: msg.requestId, error: "the MCP server fetch didn't answer in time" });
  expect(await call(router.tools.refresh, { id: offline.id }, { context })).toMatchObject({ actions: [{ name: "fetch" }], actionsError: "the MCP server fetch didn't answer in time" });
});

test("a runner tool has no URL or headers, and stays on its runner while an agent uses it", async () => {
  const context = await ownerContext();
  const runnerId = await runnerWith(context, ["fetch", "brave-search"]);
  const other = await runnerWith(context, ["fetch"]);
  const tool = await call(router.tools.create, { kind: "runner", name: "Fetch", runnerId, runnerTool: "fetch" }, { context });
  await expect(call(router.tools.update, { id: tool.id, url: "https://example.com/mcp" }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.tools.update, { id: tool.id, headers: { authorization: "x" } }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.tools.update, { id: tool.id, runnerTool: "missing" }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await call(router.tools.update, { id: tool.id, name: "Search", runnerTool: "brave-search" }, { context })).toMatchObject({ name: "Search", runnerTool: "brave-search", runnerId });
  expect((await context.db.select().from(tools).where(eq(tools.id, tool.id)))[0]!.permissionRevision).toBe(1);

  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  await call(router.agents.create, { name: "Searcher", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] }, { context });
  await expect(call(router.tools.update, { id: tool.id, runnerId: other, runnerTool: "fetch" }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
    message: "The agent “Searcher” uses this tool: it stays on its runner",
  });
  // An HTTP tool has no runner.
  const server = await fake();
  const http = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: {} }, { context });
  await expect(call(router.tools.update, { id: http.id, runnerId, runnerTool: "fetch" }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a tool pointed at another server asks again for everything: the unasked actions were the old server's", async () => {
  const context = await ownerContext();
  const first = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: first.url, transport: "streamable-http", headers: {} }, { context });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] }, { context });
  await call(router.agents.setToolAsk, { agentId: agent.id, toolId: tool.id, action: "echo", ask: false }, { context });
  const asks = async () => (await call(router.agents.toolAsk, { id: agent.id }, { context }))[0]!.actions.map((a) => [a.name, a.ask]);
  expect(await asks()).toEqual([["echo", false]]);
  // Renaming it moves nothing.
  await call(router.tools.update, { id: tool.id, name: "Echo 2" }, { context });
  expect(await asks()).toEqual([["echo", false]]);
  expect((await context.db.select().from(tools).where(eq(tools.id, tool.id)))[0]!.permissionRevision).toBe(0);
  // Another server with an action of the same name: it is not the action the owner let run.
  const second = await fake();
  await call(router.tools.update, { id: tool.id, url: second.url }, { context });
  expect(await asks()).toEqual([["echo", true]]);
  expect((await context.db.select().from(tools).where(eq(tools.id, tool.id)))[0]!.permissionRevision).toBe(1);
});

test("runner tools expose asking flags and the owner can change them", async () => {
  const context = await ownerContext();
  const runnerId = await runnerWith(context, ["fetch"]);
  const tool = await call(router.tools.create, { kind: "runner", name: "Fetch", runnerId, runnerTool: "fetch" }, { context });
  await context.db.update(tools).set({ actions: [{ name: "get", description: "", inputSchema: { type: "object" } }] }).where(eq(tools.id, tool.id));
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Searcher", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] }, { context });
  expect(await call(router.agents.toolAsk, { id: agent.id }, { context })).toMatchObject([{ toolId: tool.id, actions: [{ name: "get", ask: true }] }]);
  await call(router.agents.setToolAsk, { agentId: agent.id, toolId: tool.id, action: "get", ask: false }, { context });
  expect(await call(router.agents.toolAsk, { id: agent.id }, { context })).toMatchObject([{ toolId: tool.id, actions: [{ name: "get", ask: false }] }]);
});
