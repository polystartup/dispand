import type { Answer, QuestionPayload } from "@dispand/runner-protocol";
import { expect, test } from "vitest";
import { requestApproval } from "./outcome.ts";

const asking = () => {
  const asked: QuestionPayload[] = [];
  const ask = async (payload: QuestionPayload): Promise<Answer> => (asked.push(payload), { kind: "permission", decision: "allow" });
  return { asked, ask };
};

test("request_approval carries a proposal's id with the question, next to the agent's words", async () => {
  const { asked, ask } = asking();
  expect(await requestApproval(ask, { message: "May I add a clerk?", proposal: "prop_01ABC" })).toMatchObject({ ok: true, approved: true });
  expect(await requestApproval(ask, { message: "Just words?" })).toMatchObject({ ok: true, approved: true });
  expect(asked.map((q) => (q as { input: unknown }).input)).toEqual([{ message: "May I add a clerk?", proposal: "prop_01ABC" }, { message: "Just words?" }]);
});

test("a proposal that isn't an id is a bad call, not a request without one: the owner is never asked words in its place", async () => {
  const { asked, ask } = asking();
  for (const proposal of [42, "", "has space", "x".repeat(65), { id: "prop_1" }, null]) {
    const outcome = await requestApproval(ask, { message: "May I?", proposal });
    expect(outcome).toMatchObject({ ok: false, approved: false });
    expect(outcome.text).toMatch(/proposal/);
  }
  expect(asked).toEqual([]);
});
