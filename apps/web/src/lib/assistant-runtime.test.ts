import { expect, test } from "vitest";
import type { RunSnapshot } from "./run-state.ts";
import type { RecordResult } from "@dispand/domain/messages/record-result.ts";
import { applyRunEvent } from "./run-state.ts";
import { ARTIFACT_TOOL, CONSULT_TOOL, QUESTION_TOOL, RECORD_TOOL, threadMessages, TRACE_TOOL } from "./assistant-runtime.ts";

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

test("a consult is a line of the chat, not a question: the owner has nothing to answer", () => {
  const consult = { ...question("q1", 1), payload: { kind: "consult" as const, agentId: "agent_1", question: "Which plan?" } };
  const thread = threadMessages(snapshot([message("m1", "user", "Plan my day", 0)], [consult]), "s_chat");
  expect(thread.map((m) => m.id)).toEqual(["m1", "q:q1"]);
  expect(thread[1]!.content).toEqual([{ type: "tool-call", toolCallId: "q1", toolName: CONSULT_TOOL, args: { questionId: "q1" } }]);
  // One that expired with its step is left out, as any question is.
  expect(threadMessages(snapshot([], [{ ...consult, status: "expired" as const }]), "s_chat")).toEqual([]);
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

test("adjacent traces share a message without swallowing text or questions", () => {
  const thread = threadMessages(snapshot([message("t1", "tool", "Read", 1), message("t2", "tool", "Bash", 2), message("a", "assistant", "Done", 3), message("t3", "tool", "Read", 4), message("t4", "tool", "Bash", 6)], [question("q", 5)]), "s_chat");
  expect(thread.map((m) => m.id)).toEqual(["t1", "a", "t3", "q:q", "t4"]);
  expect(thread[0]!.content).toEqual([
    { type: "tool-call", toolCallId: "t1", toolName: TRACE_TOOL, args: { text: "Read" }, result: "done" },
    { type: "tool-call", toolCallId: "t2", toolName: TRACE_TOOL, args: { text: "Bash" }, result: "done" },
  ]);
});

test("a saved record replaces its trace with real arguments and result, outside routine groups", () => {
  const started = message("record", "tool", "rows_get", 2);
  const first = snapshot([message("t1", "tool", "Read", 1), started, message("t2", "tool", "Search", 3)], []);
  expect(threadMessages(first, "s_chat")).toHaveLength(1);
  const record: RecordResult = { kind: "record", tableId: "table_1", rowId: "row_1", fields: [{ id: "f1", name: "Name", type: "text", value: "Client" }] };
  const result = { toolCallId: "call_1", turnId: "turn_1", args: { id: "row_1" }, record };
  const updated = applyRunEvent(first, { type: "message", message: { ...started, result } });
  const thread = threadMessages(updated, "s_chat");
  expect(thread.map((item) => item.id)).toEqual(["t1", "record", "t2"]);
  expect(thread[1]!.content).toEqual([{ type: "tool-call", toolCallId: "turn_1:call_1", toolName: RECORD_TOOL, args: { id: "row_1" }, result: record }]);
});

test("an artifact's reference becomes its own finished tool call, never a trace, with no code in it", () => {
  const ref = { kind: "artifact" as const, artifactId: "art_1", title: "Chart", format: "html" as const, size: 42 };
  const thread = threadMessages(snapshot([message("t1", "tool", "Read", 1), { ...message("a1", "tool", "artifact_show", 2), result: ref }, message("t2", "tool", "Search", 3)], []), "s_chat");
  expect(thread.map((item) => item.id)).toEqual(["t1", "a1", "t2"]);
  expect(thread[1]!.content).toEqual([{ type: "tool-call", toolCallId: "art_1", toolName: ARTIFACT_TOOL, args: {}, result: ref }]);
});

test("provider call ids reused in later turns retain separate record identities", () => {
  const record = { kind: "record", tableId: "table_1", rowId: "row_1", fields: [] };
  const thread = threadMessages(snapshot(["turn_1", "turn_2"].map((turnId, i) => ({
    ...message("m" + i, "tool", "rows_get", i),
    result: { toolCallId: "call_1", turnId, args: { id: "row_1" }, record },
  })), []), "s_chat");
  expect(thread.flatMap((item) => typeof item.content === "string" ? [] : item.content).map((part) => part.type === "tool-call" ? part.toolCallId : null)).toEqual(["turn_1:call_1", "turn_2:call_1"]);
});

test("held attachments report upload progress before server validation and send the server id", async () => {
  const { heldAttachments } = await import("./assistant-runtime.ts");
  const file = new File(["image"], "photo.svg", { type: "image/svg+xml" });
  const adapter = heldAttachments(async () => ({ id: "att_trusted", image: true }));
  const upload = adapter.add({ file });
  expect(Symbol.asyncIterator in upload).toBe(true);
  if (!(Symbol.asyncIterator in upload)) throw new Error("expected streamed upload");
  const first = (await upload.next()).value!;
  const ready = (await upload.next()).value!;
  expect(first.status.type).toBe("running");
  expect(first.type).toBe("file");
  expect(first.content).toEqual([]);
  expect(ready.id).toBe(first.id);
  expect(ready.content).toEqual([{ type: "image", image: "/files/att_trusted" }]);
  expect((await heldAttachments(async () => { throw new Error("unused"); }).send(ready)).id).toBe("att_trusted");
});

test("an untrusted image MIME never supplies preview content", async () => {
  const { heldAttachments } = await import("./assistant-runtime.ts");
  const adapter = heldAttachments(async () => ({ id: "att_file", image: false }));
  const upload = adapter.add({ file: new File(["<svg/>"], "photo.png", { type: "image/png" }) });
  if (!(Symbol.asyncIterator in upload)) throw new Error("expected streamed upload");
  await upload.next();
  const ready = (await upload.next()).value!;
  expect(ready.type).toBe("file");
  expect(ready.content).toEqual([]);
});

test("sent image previews require the stored server raster flag; legacy files stay downloads", () => {
  const [sent] = threadMessages(snapshot([{ ...message("m_files", "user", "", 1), files: [{ id: "att_raster", name: "photo", image: true }, { id: "att_legacy", name: "photo.png" }, { id: "att_svg", name: "image.svg", image: false }] }], []), "s_chat");
  expect(sent!.attachments).toEqual([
    { id: "att_raster", type: "image", name: "photo", status: { type: "complete" }, content: [{ type: "image", image: "/files/att_raster" }] },
    { id: "att_legacy", type: "file", name: "photo.png", status: { type: "complete" }, content: [] },
    { id: "att_svg", type: "file", name: "image.svg", status: { type: "complete" }, content: [] },
  ]);
});
