import { call } from "@orpc/server";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { ownerContext } from "../runners/test-support.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { base } from "./context.ts";
import { router } from "./router.ts";

afterEach(() => stopTelemetry());

const refused = (field: string) => ({ code: "BAD_REQUEST", data: { key: "validation.unstorable", values: { field } } });

test("an input PostgreSQL can't store is refused before any query reads it, its field named", async () => {
  const context = await ownerContext();
  // A plain `z.string()` id or name: its query failed on the NUL, a 500.
  await expect(call(router.agents.get, { id: "agent_\u0000" }, { context })).rejects.toMatchObject(refused("id"));
  await expect(call(router.runners.create, { name: "a\u0000b" }, { context })).rejects.toMatchObject(refused("name"));
  // Deep in a free-form value, a key included (jsonb refuses a lone surrogate too), and before the
  // read that would find no such agent.
  const config = { kind: "poll" as const, toolId: "tool_x", action: "list", itemsPath: "", idPath: "id" };
  await expect(call(router.triggers.create, { agentId: "agent_x", name: "Mail", instructions: "", config: { ...config, arguments: { filter: ["a\ud800"] } } }, { context })).rejects.toMatchObject(refused("config.arguments.filter.0"));
  await expect(call(router.triggers.create, { agentId: "agent_x", name: "Mail", instructions: "", config: { ...config, arguments: { "f\u0000": 1 } } }, { context })).rejects.toMatchObject(refused("config.arguments"));
});

test("an input is walked as deep as it may nest and refused past that, a file passes as it came, and a refusal is traced as BAD_REQUEST without the input", async () => {
  const t = await captureTelemetry();
  const at = (name: string) => ({ context: {} as never, path: [name] });
  const take = base.input(z.unknown()).handler(() => "taken");
  const nested = (depth: number, inner: unknown) => Array.from({ length: depth }).reduce<unknown>((value) => [value], inner);
  const bottom = Array(1000).fill(0).join(".");
  // As deep as an input may nest: walked to its end.
  await expect(call(take, nested(1000, "a sentinel\u0000"), at("take"))).rejects.toMatchObject(refused(bottom));
  await expect(call(take, nested(1000, "fine"), at("take"))).resolves.toBe("taken");
  // Anyone can send a deeper one before the gates: refused at the first container past that depth,
  // so the walk holds no more than that many, however deep the rest goes.
  for (const deep of [nested(1000, []), nested(200_000, "a sentinel\u0000")]) {
    await expect(call(take, deep, at("take"))).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "validation.tooDeep", values: { field: bottom, maximum: 1000 } } });
  }
  // A file's name and bytes are no strings of the input: an upload passes, its name cleaned once stored.
  const upload = base.input(z.object({ file: z.file() })).handler(({ input }) => input.file);
  const file = new File(["a\u0000b"], "a\u0000.png");
  await expect(call(upload, { file }, at("upload"))).resolves.toBe(file);
  expect(t.spans().filter((s) => s.attributes["rpc.method"]).map((s) => [s.name, s.attributes["dispand.result"]])).toEqual([["take", "BAD_REQUEST"], ["take", "ok"], ["take", "BAD_REQUEST"], ["take", "BAD_REQUEST"], ["upload", "ok"]]);
  // The refusals by their kind only: neither the value nor the message, which names the field.
  expect(await t.all()).not.toMatch(/sentinel|can't store|levels deep/);
});
