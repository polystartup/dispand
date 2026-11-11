import { call } from "@orpc/server";
import { afterEach, expect, test } from "vitest";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { callPlatformTool } from "../platform/call.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { router } from "./router.ts";

afterEach(() => stopTelemetry());

test("each procedure is a span named after it, with its owner and how it ended, never its input or output", async () => {
  const context = await ownerContext();
  const t = await captureTelemetry();
  const secretValue = "Ada Lovelace, the sentinel row value";
  // As the RPC handler calls them: with their path.
  const at = (path: string) => ({ context, path: path.split(".") });
  const table = await call(router.tables.create, { name: "Clients" }, at("tables.create"));
  const name = (await call(router.tables.get, { id: table.id }, at("tables.get"))).fields[0]!;
  await call(router.rows.create, { tableId: table.id, values: { [name.id]: secretValue } }, at("rows.create"));
  await call(router.rows.get, { id: "row_missing" }, at("rows.get")).catch(() => {});
  const spans = t.spans().filter((s) => s.attributes["rpc.method"]);
  expect(spans.map((s) => [s.name, s.attributes["dispand.result"]])).toEqual([
    ["tables.create", "ok"],
    ["tables.get", "ok"],
    ["rows.create", "ok"],
    ["rows.get", "NOT_FOUND"],
  ]);
  for (const s of spans) expect(s.attributes["dispand.owner.id"]).toBe(context.ownerId);
  expect(spans.at(-1)!.events.map((e) => e.attributes)).toEqual([{ "exception.type": "NOT_FOUND" }]);
  // Durations by procedure and result, nothing else.
  const points = (await t.metrics()).filter((m) => m.name === "dispand.rpc.duration");
  expect(points.map((p) => p.attributes)).toContainEqual({ "rpc.method": "rows.get", "dispand.result": "NOT_FOUND" });
  expect(await t.all()).not.toContain(secretValue);
});

test("a call a Job makes through its tools is a span of the same procedure, with the Job's id", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", bundles: ["data"] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const t = await captureTelemetry();
  await callPlatformTool(context, { runId, ownerId: context.ownerId, agentId: agent.id }, "tables_list", {});
  const [span] = t.spans().filter((s) => s.name === "tables.list");
  expect(span!.attributes).toMatchObject({ "rpc.method": "tables.list", "dispand.owner.id": context.ownerId, "dispand.job.id": runId, "dispand.result": "ok" });
});
