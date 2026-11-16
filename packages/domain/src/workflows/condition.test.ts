import { expect, test } from "vitest";
import { evaluateCondition, type ConditionOp } from "./condition.ts";
import { stored } from "../messages/index.ts";

test.each<[ConditionOp, string, string, boolean]>([
  ["equals", " Yes ", "yes", true],
  ["equals", "yes", "no", false],
  ["not_equals", "Yes", "yes", false],
  ["contains", "Hello World", "world", true],
  ["not_contains", "Hello World", "moon", true],
  ["is_empty", "  ", "", true],
  ["is_empty", "x", "", false],
  ["is_not_empty", "x", "ignored", true],
  ["greater_than", "10", "9.5", true],
  ["greater_than", "9", "9", false],
  ["less_than", " -1 ", "0", true],
])("evaluateCondition(%s, %j, %j) is %s", (op, value, operand, matched) => {
  expect(evaluateCondition(op, value, operand)).toEqual({ matched });
});

test("greater_than on a non-number is an error", () => {
  expect(evaluateCondition("greater_than", "abc", "3")).toEqual({ error: stored("engine.fail.notNumber", { text: "abc" }) });
  expect(evaluateCondition("less_than", "3", " ")).toEqual({ error: stored("engine.fail.notNumber", { text: "" }) });
  expect(evaluateCondition("less_than", "x".repeat(100), "3")).toEqual({ error: stored("engine.fail.notNumber", { text: "x".repeat(80) }) });
});
