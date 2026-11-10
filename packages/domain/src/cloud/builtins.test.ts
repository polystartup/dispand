import { expect, test } from "vitest";
import { approvalMessage } from "./builtins.ts";

test("request_approval's arguments: the words, and a proposal's id when one is named; a proposal that isn't an id is refused", () => {
  expect(approvalMessage({ message: " May I? " })).toEqual({ message: "May I?" });
  expect(approvalMessage({ message: "May I?", proposal: "prop_01ABC" })).toEqual({ message: "May I?", proposal: "prop_01ABC" });
  for (const proposal of [42, "", "has space", "x".repeat(65), { id: "prop_1" }, null]) {
    expect(approvalMessage({ message: "May I?", proposal })).toMatchObject({ error: expect.stringContaining("proposal") });
  }
});
