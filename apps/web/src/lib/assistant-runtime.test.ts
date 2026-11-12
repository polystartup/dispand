import { expect, test } from "vitest";
import type { RunSnapshot } from "./run-state.ts";
import { applyRunEvent } from "./run-state.ts";
import { QUESTION_TOOL, threadMessages, TRACE_TOOL } from "./assistant-runtime.ts";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const message = (id: string, role: "assistant" | "user" | "tool", text: string, s: number, stepRunId = "s_chat") => ({ id, role, text, createdAt: at(s), stepRunId, runId: "run_1" });
const question = (id: string, s: number, status: "pending" | "answered" | "expired" = "pending", stepRunId = "s_chat") => ({
  id,
  runId: "run_1",
  stepRunId,
  placement: "chat" as const,
  status,
  createdAt: at(s),
  about: null,
  proposalId: null,
  payload: { kind: "choice" as const, questions: [{ question: "Who?", header: "Who", options: [{ label: "Me" }, { label: "You" }], multiSelect: false }] },
  answer: status === "answered" ? { kind: "choice" as const, answers: { "Who?": "Me" } } : null,
});
const snapshot = (messages: unknown[], questions: unknown[]) => ({ run: { id: "run_1", status: "running" }, steps: [], messages, questions }) as unknown as RunSnapshot;

test("a run's chat becomes a thread in the order things came: texts, a tool's trace and a question between them, each once", () => {
  const run = snapshot(
    [message("m1", "user", "Plan my day", 1), message("m2", "assistant", "Let me look.", 2), message("m3", "tool", "Read", 3), message("m5", "assistant", "Done.", 5), message("x1", "assistant", "Another step's words", 2, "s_other")],
    [question("q1", 4), question("q2", 6, "expired"), question("q3", 4, "pending", "s_other")],
  );
  const thread = threadMessages(run, "s_chat");
  expect(thread.map((m) => [m.id, m.role])).toEqual([
    ["m1", "user"],
    ["m2", "assistant"],
    ["m3", "assistant"],
    ["q:q1", "assistant"],
    ["m5", "assistant"],
  ]);
  expect(thread[0]!.content).toEqual([{ type: "text", text: "Plan my day" }]);
  // The library has no tool role: a trace is a finished tool call of the assistant.
  expect(thread[2]!.content).toEqual([{ type: "tool-call", toolCallId: "m3", toolName: TRACE_TOOL, args: { text: "Read" }, result: "done" }]);
  // A pending question is a tool call with no result yet.
  expect(thread[3]!.content).toEqual([{ type: "tool-call", toolCallId: "q1", toolName: QUESTION_TOOL, args: { questionId: "q1" } }]);
});

test("a consult has no place in the chat: the owner doesn't answer it", () => {
  const consult = { ...question("q1", 1), payload: { kind: "consult" as const, agentId: "agent_1", question: "Which plan?" } };
  expect(threadMessages(snapshot([message("m1", "user", "Plan my day", 0)], [consult]), "s_chat").map((m) => m.id)).toEqual(["m1"]);
});

test("an answered question carries its answer as the result", () => {
  const [q] = threadMessages(snapshot([], [question("q1", 1, "answered")]), "s_chat");
  expect(q!.content).toEqual([{ type: "tool-call", toolCallId: "q1", toolName: QUESTION_TOOL, args: { questionId: "q1" }, result: { kind: "choice", answers: { "Who?": "Me" } } }]);
});

test("an event adds or changes one message and leaves the others as they were", () => {
  const first = snapshot([message("m1", "user", "Hi", 1), message("m2", "assistant", "Hel", 2)], [question("q1", 3)]);
  const before = threadMessages(first, "s_chat");
  // A streamed delta replaces m2; a new message arrives; q1 is answered.
  let next = applyRunEvent(first, { type: "message", message: message("m2", "assistant", "Hello", 2) } as never)!;
  next = applyRunEvent(next, { type: "message", message: message("m4", "assistant", "More", 4) } as never)!;
  const after = threadMessages(next, "s_chat");
  expect(after.map((m) => m.id)).toEqual(["m1", "m2", "q:q1", "m4"]);
  expect(after[0]).toBe(before[0]);
  expect(after[2]).toBe(before[2]);
  expect(after[1]).not.toBe(before[1]);
  expect(after[1]!.content).toEqual([{ type: "text", text: "Hello" }]);
  // Asked again with the same rows: the same objects.
  expect(threadMessages(next, "s_chat")[3]).toBe(after[3]);
});

test("no run, or no chat step yet: an empty thread", () => {
  expect(threadMessages(null, undefined)).toEqual([]);
  expect(threadMessages(snapshot([message("m1", "user", "Hi", 1)], []), undefined)).toEqual([]);
});
