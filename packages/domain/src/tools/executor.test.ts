import { call } from "@orpc/server";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { tools, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { ToolStep } from "../workflows/model.ts";
import type { ArgValue } from "./arguments.ts";
import { connectorToolExecutor, InstalledTools, loadToolSchemas } from "./executor.ts";
import { startFakeMcp, type FakeAction, type FakeMcp } from "./test-server.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const SECRET = "Bearer s3cret-value";

/** `create_repository(name required, private optional)`, recording each call's arguments. */
function github(calls: Record<string, unknown>[], answer: FakeAction["call"] = () => ({ content: [{ type: "text", text: '{"html_url":"https://x","id":7}' }] })): FakeAction {
  return {
    name: "create_repository",
    inputSchema: { type: "object", properties: { name: { type: "string" }, private: { type: "boolean" } }, required: ["name"] },
    call: (args) => {
      calls.push(args);
      return answer!(args);
    },
  };
}

async function setup(action: FakeAction) {
  const context = await ownerContext();
  const server = await startFakeMcp([action]);
  servers.push(server);
  const tool = await call(router.tools.create, { name: "GitHub", url: server.url, transport: "streamable-http", headers: { Authorization: SECRET } }, { context });
  const executor = connectorToolExecutor(new InstalledTools(context.db, context.secrets, context.tools));
  const step: ToolStep = { id: "n_tool", key: "github", type: "tool", name: "GitHub", toolId: tool.id, action: "create_repository", inputs: [] };
  const run = (values: Record<string, ArgValue>, s: ToolStep = step) => executor.run(context.ownerId, s, new Map(Object.entries(values)), new AbortController().signal);
  return { context, server, tool, step, run };
}

test("a tool step calls the action with its coerced values and gives result and fields", async () => {
  const calls: Record<string, unknown>[] = [];
  const { run } = await setup(github(calls));
  expect(await run({ name: "acme", private: "TRUE" })).toEqual({ ok: true, outputs: { result: '{"html_url":"https://x","id":7}', html_url: "https://x", id: "7" } });
  expect(calls).toEqual([{ name: "acme", private: true }]);
});

test("a wrong argument type fails without calling the tool", async () => {
  const calls: Record<string, unknown>[] = [];
  const { run } = await setup(github(calls));
  expect(await run({ name: "acme", private: "yes" })).toEqual({ ok: false, error: "“private” must be true or false" });
  expect(await run({ name: { skipped: "Brief" } })).toEqual({ ok: false, error: "“name” has no value (“Brief” was skipped)" });
  expect(calls).toEqual([]);
});

test("an error result fails the step, with the tool's headers redacted", async () => {
  const { run } = await setup(github([], () => ({ content: [{ type: "text", text: `bad token ${SECRET}` }], isError: true })));
  const result = await run({ name: "acme" });
  expect(result).toEqual({ ok: false, error: "The tool answered with an error: bad token ••••" });
  expect(JSON.stringify(result)).not.toContain("s3cret");
});

test("an unreachable tool fails with a short reason, never the header", async () => {
  const { run, server } = await setup(github([]));
  await server.close();
  const result = await run({ name: "acme" });
  expect(result).toEqual({ ok: false, error: `Couldn't reach ${new URL(server.url).host}` });
});

test("a tool or action that's gone, or another owner's tool, fails the step", async () => {
  const { run, step, tool, context } = await setup(github([]));
  expect(await run({ name: "acme" }, { ...step, action: "delete_repository" })).toEqual({ ok: false, error: "GitHub no longer has the action “delete_repository”" });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  const executor = connectorToolExecutor(new InstalledTools(context.db, context.secrets, context.tools));
  expect(await executor.run("user_other", step, new Map([["name", "acme"]]), new AbortController().signal)).toEqual({ ok: false, error: "The step's tool no longer exists" });
  expect(await loadToolSchemas(context.db, "user_other", [tool.id])).toEqual([]);
  expect(await loadToolSchemas(context.db, context.ownerId, [tool.id])).toMatchObject([{ id: tool.id, name: "GitHub", kind: "http" }]);
  await call(router.tools.delete, { id: tool.id }, { context });
  expect(await run({ name: "acme" })).toEqual({ ok: false, error: "The step's tool no longer exists" });
});

test("a runner tool in a Tool step fails without a call", async () => {
  const { context, step } = await setup(github([]));
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  await context.db.insert(tools).values({
    id: "tool_fetch",
    ownerId: context.ownerId,
    name: "Fetch",
    kind: "runner",
    runnerId,
    runnerTool: "fetch",
    actions: [{ name: "create_repository", description: "", inputSchema: { type: "object" } }],
  });
  const executor = connectorToolExecutor(new InstalledTools(context.db, context.secrets, context.tools));
  expect(await executor.run(context.ownerId, { ...step, toolId: "tool_fetch" }, new Map(), new AbortController().signal)).toEqual({
    ok: false,
    error: "Fetch runs on a runner: only an agent can use it",
  });
});

test("a tool call is a span with the tool and the action and how it ended, never its arguments or its answer", async () => {
  const calls: Record<string, unknown>[] = [];
  const { run, tool } = await setup(github(calls, () => ({ content: [{ type: "text", text: "sentinel-tool-answer" }] })));
  const t = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  await run({ name: "sentinel-tool-argument" });
  const [span] = t.spans().filter((x) => x.name === "tool.call");
  expect(span!.attributes).toEqual({ "dispand.tool.id": tool.id, "dispand.tool.action": "create_repository", "dispand.result": "ok" });
  expect(await t.metrics()).toContainEqual({ name: "dispand.tool.calls", attributes: { "dispand.result": "ok" } });
  const all = await t.all();
  for (const sentinel of ["sentinel-tool-argument", "sentinel-tool-answer", SECRET]) expect(all).not.toContain(sentinel);
});
