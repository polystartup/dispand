import type { Answer, HarnessEvent, QuestionPayload } from "@dispand/runner-protocol";
import { expect, test, vi } from "vitest";
import { requestApproval, sessionOutcome } from "./outcome.ts";

test("a chat with no expected outputs accepts completion without asking the owner", async () => {
  const events: HarnessEvent[] = [];
  const ask = vi.fn();
  const finish = vi.fn();
  const outcome = sessionOutcome({ interactive: true, expectedOutputs: [] }, { emit: (event) => events.push(event), ask, finish, say: vi.fn() });
  expect(await outcome.submit({}, new AbortController().signal)).toBe("confirmed");
  expect(ask).not.toHaveBeenCalled();
  expect(events).toEqual([{ type: "outputs-accepted", values: {} }]);
  outcome.turnEnded({ text: "Done.", interrupted: false, queued: false });
  expect(finish).toHaveBeenCalledWith({ type: "result", text: "Done." });
});

test("a workflow chat with outputs still asks for confirmation", async () => {
  const ask = vi.fn().mockResolvedValue({ kind: "confirm-outputs", confirmed: true });
  const emit = vi.fn();
  const outcome = sessionOutcome({ interactive: true, expectedOutputs: [{ name: "summary", type: "string" }] }, { emit, ask, finish: vi.fn(), say: vi.fn() });
  await outcome.submit({ summary: "Ready." }, new AbortController().signal);
  expect(ask).toHaveBeenCalledWith({ kind: "confirm-outputs", values: { summary: "Ready." } }, expect.any(AbortSignal));
  expect(emit).toHaveBeenCalledWith({ type: "outputs-accepted", values: { summary: "Ready." } });
});

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
