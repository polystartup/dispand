import { expect, test } from "vitest";
import { lineDiff } from "./line-diff.ts";

test("marks only the lines that differ", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
    { kind: "same", line: "a" },
    { kind: "del", line: "b" },
    { kind: "add", line: "B" },
    { kind: "same", line: "c" },
    { kind: "add", line: "d" },
  ]);
});
