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

test("gives up on texts too different and long to compare cheaply", () => {
  const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n");
  expect(lineDiff(many(2000, "a"), many(2000, "b"))).toBeNull();
});
