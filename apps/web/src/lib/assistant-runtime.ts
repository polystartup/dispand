import { type AppendMessage, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import type { RunSnapshot } from "./run-state.ts";

// The one place Dispand's runs meet assistant-ui. Dispand keeps its own messages, questions and
// streams; here a run's chat is turned into the library's thread messages, and the library's
// runtime is fed from them (`useExternalStoreRuntime`). An upgrade of the library touches this
// module and `components/chat/`.

type Message = RunSnapshot["messages"][number];
type Question = RunSnapshot["questions"][number];

/** A tool's trace line ("Read", "Bash"…): the library has no tool role, so it is a finished tool call of the assistant. */
export const TRACE_TOOL = "dispand_trace";
/** A question of the chat: a tool call with no result while it waits, its answer as the result after. */
export const QUESTION_TOOL = "dispand_question";

/** A question's message id in the thread (its tool call's id is the question's own). */
export const questionMessageId = (questionId: string) => `q:${questionId}`;

// One thread message per row, kept while the row is the same object: an event replaces only the
// row it changes (`applyRunEvent`), so the rest of a long conversation is not built again.
const converted = new WeakMap<object, ThreadMessageLike>();

function ofMessage(m: Message): ThreadMessageLike {
  const createdAt = new Date(m.createdAt);
  if (m.role === "tool") {
    return { id: m.id, role: "assistant", createdAt, content: [{ type: "tool-call", toolCallId: m.id, toolName: TRACE_TOOL, args: { text: m.text }, result: "done" }] };
  }
  return { id: m.id, role: m.role, createdAt, content: [{ type: "text", text: m.text }] };
}

function ofQuestion(q: Question): ThreadMessageLike {
  return {
    id: questionMessageId(q.id),
    role: "assistant",
    createdAt: new Date(q.createdAt),
    content: [{ type: "tool-call", toolCallId: q.id, toolName: QUESTION_TOOL, args: { questionId: q.id }, ...(q.status === "answered" && q.answer ? { result: q.answer } : {}) }],
  };
}

function kept<T extends object>(row: T, make: (row: T) => ThreadMessageLike): ThreadMessageLike {
  let message = converted.get(row);
  if (!message) converted.set(row, (message = make(row)));
  return message;
}

/**
 * The chat of a run as a thread: the chat step's messages and its questions (but those that
 * expired, and consults), in the order they came.
 */
export function threadMessages(run: RunSnapshot | null, chatStepId: string | undefined): ThreadMessageLike[] {
  if (!run || !chatStepId) return [];
  return [
    ...run.messages.filter((m) => m.stepRunId === chatStepId).map((m) => ({ at: new Date(m.createdAt).getTime(), message: kept(m, ofMessage) })),
    // A consult asks nothing of the owner: it has no place to answer it here.
    ...run.questions.filter((q) => q.stepRunId === chatStepId && q.status !== "expired" && q.payload.kind !== "consult").map((q) => ({ at: new Date(q.createdAt).getTime(), message: kept(q, ofQuestion) })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((item) => item.message);
}

const same = (m: ThreadMessageLike) => m;

/** The text of what the owner sent from the composer. */
export const textOf = (message: AppendMessage) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/**
 * The library's runtime over a run's chat. `canSend`: false while the conversation is over or a question waits; `onSend` sends the
 * owner's words through Dispand's own procedures.
 */
export function useRunThread(options: { run: RunSnapshot | null; chatStepId: string | undefined; canSend: boolean; onSend: (text: string) => Promise<void> }) {
  return useExternalStoreRuntime({
    messages: threadMessages(options.run, options.chatStepId),
    convertMessage: same,
    // The run view has no turn-in-progress flag: a running chat may be idle for hours.
    // Render each text snapshot as available rather than disabling copy until the Job ends.
    // Subsequent stream events still replace its text through `messages`.
    isSendDisabled: !options.canSend,
    onNew: (message) => options.onSend(textOf(message)),
  });
}
