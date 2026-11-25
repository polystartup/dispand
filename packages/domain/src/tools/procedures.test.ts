import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { agentTools, organizations, runners, tools, user, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, ownerContext } from "../runners/test-support.ts";
import { secretAad, SecretError } from "../secrets.ts";
import { headerAad, insertTool, MAX_HEADERS, retarget, toolTarget } from "./store.ts";
import { resealToolHeaders } from "./reseal.ts";
import { startFakeMcp, type FakeAction, type FakeMcp } from "./test-server.ts";
import { stored, storedSentence, storedText } from "../messages/index.ts";

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

async function fake(actions: FakeAction[] = [echo], transport: "streamable-http" | "sse" = "streamable-http") {
  const server = await startFakeMcp(actions, transport);
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
  expect(storedSentence(tool.actionsError!)).toBe(`Couldn't reach ${new URL(server.url).host}.`);
});

test("refresh keeps the last actions when the server is gone", async () => {
  const context = await ownerContext();
  const server = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: {} }, { context });
  await server.close();
  const refreshed = await call(router.tools.refresh, { id: tool.id }, { context });
  expect(refreshed.actions).toEqual(tool.actions);
  expect(storedSentence(refreshed.actionsError!)).toMatch(/^Couldn't reach/);
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

test("an sse tool's header is bound to its origin: sealed for one, it doesn't open for another, and a move drops it", async () => {
  const context = await ownerContext();
  const first = await fake([echo], "sse");
  const tool = await call(router.tools.create, { name: "Echo", url: first.url, transport: "sse", headers: { authorization: SECRET } }, { context });
  expect(first.requests.length).toBeGreaterThan(0);
  expect(first.requests.every((h) => h.authorization === SECRET)).toBe(true);
  const second = await fake([echo], "sse");
  const [row] = await context.db.select().from(tools).where(eq(tools.id, tool.id));
  const sealed = row!.headersSealed.authorization!;
  expect(context.secrets.open(sealed, headerAad(tool.id, "authorization", first.url))).toBe(SECRET);
  expect(() => context.secrets.open(sealed, headerAad(tool.id, "authorization", second.url))).toThrow(SecretError);
  // Moved to another origin: dropped, and nothing reaches the new server.
  const moved = await call(router.tools.update, { id: tool.id, url: second.url }, { context });
  expect(moved.headerNames).toEqual([]);
  expect(second.requests.length).toBeGreaterThan(0);
  expect(second.requests.every((h) => h.authorization === undefined)).toBe(true);
  // Another transport at the same origin drops them too.
  const again = await call(router.tools.update, { id: tool.id, headers: { authorization: SECRET } }, { context });
  expect(again.headerNames).toEqual(["authorization"]);
  const switched = await call(router.tools.update, { id: tool.id, transport: "streamable-http" }, { context });
  expect(switched.headerNames).toEqual([]);
});

test("retarget keeps the headers at the same origin and drops them at another", async () => {
  const context = await ownerContext();
  const first = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: first.url, transport: "streamable-http", headers: { authorization: SECRET } }, { context });
  const [row] = await context.db.select().from(tools).where(eq(tools.id, tool.id));
  const samePlace = await retarget(context.db, row!, `${first.url}?v=2`, "streamable-http");
  expect(toolTarget(samePlace, context.secrets).headers).toEqual({ authorization: SECRET });
  const second = await fake();
  const moved = await retarget(context.db, samePlace, second.url, "streamable-http");
  expect(moved).toMatchObject({ headersSealed: {}, auth: "none" });
});

test("a header still sealed for its old origin is never sent to the tool's new one", async () => {
  const context = await ownerContext();
  const first = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: first.url, transport: "streamable-http", headers: { authorization: SECRET } }, { context });
  const second = await fake();
  // A row whose URL changed without its headers (no procedure does it): the header doesn't open there.
  await context.db.update(tools).set({ url: second.url }).where(eq(tools.id, tool.id));
  const [row] = await context.db.select().from(tools).where(eq(tools.id, tool.id));
  expect(() => toolTarget(row!, context.secrets)).toThrow(SecretError);
  const refreshed = await call(router.tools.refresh, { id: tool.id }, { context });
  expect(refreshed.actionsError).toBe(stored("tools.fail.listFailed"));
  expect(second.requests).toEqual([]);
});

test("a header sealed before the re-seal, read after the tool's origin changed, is dropped as before and never sent", async () => {
  const context = await ownerContext();
  const first = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: first.url, transport: "streamable-http", headers: {} }, { context });
  // Sealed as before headers were bound to an origin.
  const legacy = context.secrets.seal(SECRET, secretAad("tools", tool.id, "header:authorization"));
  await context.db.update(tools).set({ headersSealed: { authorization: legacy }, auth: "headers" }).where(eq(tools.id, tool.id));
  const second = await fake();
  const moved = await call(router.tools.update, { id: tool.id, url: second.url }, { context });
  expect(moved.headerNames).toEqual([]);
  expect(await resealToolHeaders(context.db, context.secrets)).toEqual({ resealed: 0 });
  const [row] = await context.db.select().from(tools).where(eq(tools.id, tool.id));
  expect(toolTarget(row!, context.secrets).headers).toEqual({});
  await call(router.tools.refresh, { id: tool.id }, { context });
  expect(second.requests.length).toBeGreaterThan(0);
  expect(second.requests.every((h) => h.authorization === undefined)).toBe(true);
});

test("headers go only to https, or plain http on this machine; no credentials in the URL", async () => {
  const context = await ownerContext();
  await expect(
    call(router.tools.create, { name: "A", url: "http://example.com/mcp", transport: "streamable-http", headers: { authorization: SECRET } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Headers are only sent to an https:// URL." });
  await expect(
    call(router.tools.create, { name: "B", url: "https://u:p@example.com/mcp", transport: "streamable-http", headers: {} }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Put credentials in a header, not in the URL." });
  await expect(
    call(router.tools.create, { name: "C", url: "https://example.com/mcp", transport: "streamable-http", headers: { "x-a": "1\r\nx-b: 2" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    call(router.tools.create, { name: "D", url: "https://example.com/mcp", transport: "streamable-http", headers: { "X-A": "1", "x-a": "2" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The header x-a is given twice." });
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

test("another workspace's tool is NOT_FOUND, another person's in the workspace is shared, and delete removes the tool", async () => {
  const context = await ownerContext();
  const server = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: {} }, { context });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.update(tools).set({ ownerId: "user_other" }).where(eq(tools.id, tool.id));
  await expect(call(router.tools.get, { id: tool.id }, { context })).resolves.toMatchObject({ id: tool.id });
  await context.db.insert(organizations).values({ id: "org_other" });
  await context.db.insert(workspaces).values({ id: "ws_other", organizationId: "org_other" });
  await context.db.update(tools).set({ workspaceId: "ws_other" }).where(eq(tools.id, tool.id));
  await expect(call(router.tools.get, { id: tool.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.tools.refresh, { id: tool.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.tools.update, { id: tool.id, name: "Mine" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.tools.delete, { id: tool.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await context.db.update(tools).set({ workspaceId: context.workspaceId }).where(eq(tools.id, tool.id));
  await call(router.tools.delete, { id: tool.id }, { context });
  expect(await call(router.tools.list, undefined, { context })).toEqual([]);
});

/** A runner of the owner, as if it had said hello reporting `reported` MCP servers. */
async function runnerWith(context: Awaited<ReturnType<typeof ownerContext>>, reported: string[]) {
  const { runnerId } = await runnerWithClis(context);
  await context.db.update(runners).set({ tools: reported }).where(eq(runners.id, runnerId));
  return runnerId;
}

test("a runner tool the runner doesn't report is refused", async () => {
  const context = await ownerContext();
  const runnerId = await runnerWith(context, ["brave-search"]);
  await expect(call(router.tools.create, { kind: "runner", name: "Fetch", runnerId, runnerTool: "fetch" }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "The runner doesn't report an MCP server named fetch: add it to the runner's config.json, then restart the runner.",
  });
  await expect(call(router.tools.create, { kind: "runner", name: "Fetch", runnerId: "runner_unknown", runnerTool: "fetch" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await context.db.select().from(tools)).toEqual([]);
});

test("a runner tool lists its actions through its runner; an offline runner gives actionsError “runner offline”", async () => {
  const context = await ownerContext();
  const runnerId = await runnerWith(context, ["fetch"]);
  const offline = await call(router.tools.create, { kind: "runner", name: "Fetch", runnerId, runnerTool: "fetch" }, { context });
  expect(offline).toMatchObject({ kind: "runner", url: null, transport: null, runnerId, runnerTool: "fetch", headerNames: [], actions: [], actionsError: stored("tools.fail.runnerOffline") });

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
  // Text shaped like a stored message is kept as words, never read as one.
  const forged = '  {"key":"engine.fail.stopped"}';
  context.hub.request = async (_id, msg) => ({ type: "tool.discovered", requestId: msg.requestId, error: forged });
  expect(storedText((await call(router.tools.refresh, { id: offline.id }, { context })).actionsError!)).toEqual({ text: forged });
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
    message: "The agent “Searcher” uses this tool: it stays on its runner.",
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
  const { runnerId } = await runnerWithClis(context);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] }, { context });
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: tool.id, action: "echo", permission: "run" }, { context });
  const asks = async () => (await call(router.agents.toolAsk, { id: agent.id }, { context }))[0]!.actions.map((a) => [a.name, a.permission === "ask"]);
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
  expect(await call(router.agents.toolAsk, { id: agent.id }, { context })).toMatchObject([{ toolId: tool.id, actions: [{ name: "get", permission: "ask" }] }]);
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: tool.id, action: "get", permission: "run" }, { context });
  expect(await call(router.agents.toolAsk, { id: agent.id }, { context })).toMatchObject([{ toolId: tool.id, actions: [{ name: "get", permission: "run" }] }]);
});


test("workspace disabling hides an action and preserves the agent's saved Run setting", async () => {
  const context = await ownerContext();
  const server = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: {} }, { context });
  const { runnerId } = await runnerWithClis(context);
  const harness = await call(router.harnesses.create, { name: "CLI", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const fields = { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] };
  const agent = await call(router.agents.create, { ...fields, toolPermissions: [{ toolId: tool.id, unasked: ["echo"] }] }, { context });
  const toggle = (enabled: boolean) => call(router.tools.setActionEnabled, { toolId: tool.id, action: "echo", enabled }, { context });
  await toggle(false);
  expect((await call(router.agents.toolAsk, { id: agent.id }, { context }))[0]!.actions).toEqual([]);
  await call(router.agents.update, { ...fields, id: agent.id, name: "Renamed", toolPermissions: [{ toolId: tool.id, unasked: [] }] }, { context });
  await toggle(true);
  expect((await call(router.agents.toolAsk, { id: agent.id }, { context }))[0]!.actions[0]!.permission).toBe("run");
  await expect(call(router.tools.setActionEnabled, { toolId: "other", action: "echo", enabled: false }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.tools.setActionEnabled, { toolId: tool.id, action: "missing", enabled: false }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});


test.each(["run", "ask", "off"] as const)("workspace availability masks and restores saved %s without granting newly discovered actions", async (permission) => {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = await call(router.harnesses.create, { name: "CLI", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const server = await fake();
  const tool = await call(router.tools.create, { name: "Echo", url: server.url, transport: "streamable-http", headers: {} }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] }, { context });
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: tool.id, action: "echo", permission }, { context });
  await call(router.tools.setActionEnabled, { toolId: tool.id, action: "echo", enabled: false }, { context });
  await expect(call(router.agents.setToolPermission, { agentId: agent.id, toolId: tool.id, action: "echo", permission: "run" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Missing actions stay disabled through discovery changes and changes to another checkbox.
  const next = { name: "new_read", description: "", inputSchema: {}, readOnly: true as const };
  await context.db.update(tools).set({ actions: [next] }).where(eq(tools.id, tool.id));
  await call(router.tools.setActionEnabled, { toolId: tool.id, action: next.name, enabled: false }, { context });
  await call(router.tools.setActionEnabled, { toolId: tool.id, action: next.name, enabled: true }, { context });
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: tool.id, action: next.name, permission: "ask" }, { context });
  await context.db.update(tools).set({ actions: [...tool.actions, next] }).where(eq(tools.id, tool.id));
  expect((await call(router.tools.get, { id: tool.id }, { context })).disabled).toEqual(["echo"]);
  await call(router.tools.setActionEnabled, { toolId: tool.id, action: "echo", enabled: true }, { context });
  expect((await call(router.agents.toolAsk, { id: agent.id }, { context }))[0]!.actions).toMatchObject([{ name: "echo", permission }, { name: next.name, permission: "ask" }]);
  await context.db.insert(organizations).values({ id: "org_other" });
  await context.db.insert(workspaces).values({ id: "ws_other", organizationId: "org_other" });
  // Taken off the agent first: an agent names only its workspace's tools.
  await context.db.delete(agentTools).where(eq(agentTools.toolId, tool.id));
  await context.db.update(tools).set({ workspaceId: "ws_other" }).where(eq(tools.id, tool.id));
  await expect(call(router.tools.setActionEnabled, { toolId: tool.id, action: "echo", enabled: false }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("each refinement of the tools inputs fires with its key, English for an agent", async () => {
  const context = await ownerContext();
  const refused = (promise: Promise<unknown>) => promise.then(() => expect.unreachable(), (err: { message: string; data?: unknown }) => err);
  const base = { name: "A", url: "https://example.com/mcp", transport: "streamable-http" as const };
  const headers = (h: Record<string, string>) => call(router.tools.create, { ...base, headers: h }, { context });
  expect(await refused(headers({ authorization: "a\nb" }))).toMatchObject({ message: "A header value is one line of text.", data: { key: "tools.headerOneLine" } });
  expect(await refused(headers(Object.fromEntries(Array.from({ length: MAX_HEADERS + 1 }, (_, i) => [`h${i}`, "v"]))))).toMatchObject({ message: `At most ${MAX_HEADERS} headers.`, data: { key: "tools.headersMax" } });
  expect(await refused(call(router.tools.update, { id: "tool_x", headers: { "bad name": "v" } }, { context }))).toMatchObject({ data: { key: "validation.invalid_key", values: { field: "headers.bad name" } } });
  expect(await refused(call(router.tools.add, { ...base, url: "https://u:p@example.com/mcp" }, { context }))).toMatchObject({ message: "The URL can't carry credentials.", data: { key: "tools.urlCredentials" } });
  expect(await refused(call(router.tools.create, { kind: "runner", name: "A", runnerId: "r", runnerTool: "fetch", catalogId: "github" }, { context }))).toMatchObject({ data: { key: "tools.notRunnerEntry" } });
  expect(await refused(call(router.tools.installFromCatalog, { catalogId: "github", settings: Object.fromEntries(Array.from({ length: MAX_HEADERS + 1 }, (_, i) => [`s${i}`, "v"])) }, { context }))).toMatchObject({ data: { key: "tools.settingsMax" } });
  expect(await refused(call(router.tools.addFromCatalog, { catalogId: "nothing" }, { context }))).toMatchObject({ message: "Not in the catalog: tools_catalog lists its entries.", data: { key: "tools.catalogNotListed" } });
  const onMachine = await refused(call(router.tools.addFromCatalog, { catalogId: "fetch" }, { context }));
  expect(onMachine).toMatchObject({ data: { key: "tools.catalogOnMachine", values: { name: expect.any(String), snippet: expect.stringContaining("mcp-server-fetch") } } });
  expect(onMachine.message).toMatch(/runs on the owner's machine.*"fetch"/s);
  expect(await refused(call(router.tools.authorize, { id: "tool_x", client: { clientId: "a\nb" } }, { context }))).toMatchObject({ message: "One line of text.", data: { key: "tools.oneLine" } });
});

test("the same tool name in two workspaces inserts", async () => {
  const context = await ownerContext();
  await context.db.insert(workspaces).values({ id: "sibling", organizationId: context.organizationId });
  const fields = { name: "Calendar", url: "https://mcp.example.com/mcp", transport: "streamable-http", headers: {} } as const;
  await insertTool(context.db, context.secrets, context.ownerId, context.workspaceId, fields);
  await insertTool(context.db, context.secrets, context.ownerId, "sibling", fields);
  await expect(insertTool(context.db, context.secrets, context.ownerId, "sibling", fields)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await context.db.select({ ws: tools.workspaceId }).from(tools)).map((t) => t.ws).sort()).toEqual([context.workspaceId, "sibling"].sort());
});
