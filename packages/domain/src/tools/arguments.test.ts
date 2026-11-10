import { TEXT } from "@dispand/runner-protocol";
import { expect, test } from "vitest";
import { actionParams, coerceArguments, toolErrorText, toolOutputs, type ArgValue } from "./arguments.ts";

const action = {
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Repository name" },
      count: { type: "integer" },
      ratio: { type: "number" },
      private: { type: "boolean" },
      topics: { type: "array" },
      meta: { type: "object" },
      note: { type: ["string", "null"] },
      free: {},
    },
    required: ["name"],
  },
};

const args = (values: Record<string, ArgValue>) => coerceArguments(action, new Map(Object.entries(values)));

test("actionParams reads the top-level properties, their types and required marks", () => {
  expect(actionParams(action).slice(0, 2)).toEqual([
    { name: "name", type: "string", description: "Repository name", required: true },
    { name: "count", type: "integer", description: "", required: false },
  ]);
  expect(actionParams(action).find((p) => p.name === "note")?.type).toBe("string");
  expect(actionParams(action).find((p) => p.name === "free")?.type).toBe("string");
  expect(actionParams({ inputSchema: {} })).toEqual([]);
});

test.each([
  [{ count: "3" }, { count: 3 }],
  [{ ratio: "3.5" }, { ratio: 3.5 }],
  [{ private: "TRUE" }, { private: true }],
  [{ private: " false " }, { private: false }],
  [{ topics: '["a"]' }, { topics: ["a"] }],
  [{ meta: '{"a":1}' }, { meta: { a: 1 } }],
  [{ note: "" }, { note: "" }],
  [{ free: "x" }, { free: "x" }],
])("coerceArguments %j", (values, expected) => {
  expect(args({ name: "acme", ...values })).toEqual({ args: { name: "acme", ...expected } });
});

test.each([
  [{ count: "3.5" }, "“count” must be a whole number"],
  [{ ratio: "abc" }, "“ratio” must be a number"],
  [{ private: "yes" }, "“private” must be true or false"],
  [{ topics: "{}" }, "“topics” must be JSON (an array)"],
  [{ meta: "[1]" }, "“meta” must be JSON (an object)"],
  [{ meta: "not json" }, "“meta” must be JSON (an object)"],
])("coerceArguments refuses %j", (values, error) => {
  expect(args({ name: "acme", ...values })).toEqual({ error });
});

test("a required parameter without a value is an error, an optional one is left out", () => {
  expect(args({})).toEqual({ error: "“name” has no value" });
  expect(args({ name: { skipped: "brief" } })).toEqual({ error: "“name” has no value (“brief” was skipped)" });
  // An empty value for anything but text is no value: the optional number is left out.
  expect(args({ name: "acme", count: "", private: { skipped: "x" } })).toEqual({ args: { name: "acme" } });
  // Names the schema doesn't have are never sent.
  expect(args({ name: "acme", extra: "x" })).toEqual({ args: { name: "acme" } });
});

test("a parameter named __proto__ stays an own property", () => {
  const result = coerceArguments({ inputSchema: { properties: JSON.parse('{"__proto__":{"type":"string"}}') as object } }, new Map([["__proto__", "x"]]));
  expect("args" in result && Object.hasOwn(result.args, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf("args" in result ? result.args : null)).toBe(Object.prototype);
});

test("toolOutputs makes NUL storable and keeps only output-name keys", () => {
  const outputs = toolOutputs({
    text: "made\u0000it",
    structured: { html_url: "https://x", "bad-key": "no", count: 3, items: [1, 2], result: "shadow", constructor: "no", owner: { login: "a\u0000" } },
  });
  expect(outputs).toEqual({ result: "made�it", html_url: "https://x", count: "3", items: "[1,2]", owner: '{"login":"a\\u0000"}' });
});

test("toolOutputs reads the fields of a JSON object text when there is no structured result", () => {
  expect(toolOutputs({ text: '{"html_url":"https://x","id":7}' })).toEqual({ result: '{"html_url":"https://x","id":7}', html_url: "https://x", id: "7" });
  expect(toolOutputs({ text: "[1,2]" })).toEqual({ result: "[1,2]" });
  expect(toolOutputs({ text: "plain" })).toEqual({ result: "plain" });
});

test("toolOutputs cuts a value longer than a prompt holds", () => {
  const { result } = toolOutputs({ text: "x".repeat(TEXT + 10) });
  expect(result!.length).toBeLessThanOrEqual(TEXT);
  expect(result!.endsWith("[truncated]")).toBe(true);
});

test("an error result fails with its first characters", () => {
  expect(toolErrorText("x".repeat(600))).toBe(`The tool answered with an error: ${"x".repeat(500)}`);
  expect(toolErrorText("  ")).toBe("The tool answered with an error");
});
