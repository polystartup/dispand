import { expect, test } from "vitest";
import { z } from "zod";
import { PLATFORM_TOOLS } from "../platform/tools.ts";
import { strictCompatible } from "./model-client.ts";

const strict = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

test("a schema is sent as strict only when providers take it: closed objects, and no string format", () => {
  expect(strictCompatible(strict({ message: { type: "string" } }))).toBe(true);
  expect(strictCompatible({ type: "object", properties: { a: { type: "string" } }, required: [] })).toBe(false);
  // OpenAI refuses the whole request for a strict tool whose string has a format it doesn't know (`uri`).
  expect(strictCompatible(strict({ url: { type: "string", format: "uri" } }))).toBe(false);
  expect(strictCompatible(strict({ nested: strict({ url: { type: "string", format: "uri" } }) }))).toBe(false);
});

test("no tool of Dispand's with a URL in its input is sent as strict", () => {
  const add = PLATFORM_TOOLS.find((t) => t.name === "tools_add")!;
  expect(strictCompatible(z.toJSONSchema(add.input))).toBe(false);
});
