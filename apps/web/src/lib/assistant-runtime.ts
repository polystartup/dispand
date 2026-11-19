import { type AppendMessage, type AttachmentAdapter, type ExternalThreadQueueAdapter, type PendingAttachment, type QueueItemState, type ThreadMessageLike, type ThreadSuggestion, useExternalStoreRuntime } from "@assistant-ui/react";
import type { RunSnapshot } from "./run-state.ts";

// The one place Dispand's runs meet assistant-ui. Dispand keeps its own messages, questions and
// streams; here a run's chat is turned into the library's thread messages, and the library's
// runtime is fed from them (`useExternalStoreRuntime`). An upgrade of the library touches this
// module and `components/chat/`.

type Message = RunSnapshot["messages"][number];
type Question = RunSnapshot["questions"][number];
type Queued = RunSnapshot["queue"][number];

/** A tool's trace line ("Read", "Bash"…): the library has no tool role, so it is a finished tool call of the assistant. */
export const TRACE_TOOL = "dispand_trace";
/** A saved, authorized rows_get result; its values already carry display labels. */
export const RECORD_TOOL = "rows_get";
/** A generated artifact (`artifact_show`): its stored reference; the code is fetched when the owner runs or reads it. */
export const ARTIFACT_TOOL = "artifact_show";
/** A question of the chat: a tool call with no result while it waits, its answer as the result after. */
export const QUESTION_TOOL = "dispand_question";
/** A consult of the chat's agent: one line naming the agent it asks, with nothing to answer. */
export const CONSULT_TOOL = "dispand_consult";

/** A question's message id in the thread (its tool call's id is the question's own). */
export const questionMessageId = (questionId: string) => `q:${questionId}`;

// One thread message per row, kept while the row is the same object: an event replaces only the
// row it changes (`applyRunEvent`), so the rest of a long conversation is not built again.
const converted = new WeakMap<object, ThreadMessageLike>();

function ofMessage(m: Message): ThreadMessageLike {
  const createdAt = new Date(m.createdAt);
  if (m.role === "tool") {
    if (m.result && "artifactId" in m.result) return { id: m.id, role: "assistant", createdAt, content: [{ type: "tool-call", toolCallId: m.result.artifactId, toolName: ARTIFACT_TOOL, args: {}, result: m.result }] };
    if (m.result && "record" in m.result) return { id: m.id, role: "assistant", createdAt, content: [{ type: "tool-call", toolCallId: `${m.result.turnId}:${m.result.toolCallId}`, toolName: RECORD_TOOL, args: m.result.args, result: m.result.record }] };
    return { id: m.id, role: "assistant", createdAt, content: [{ type: "tool-call", toolCallId: m.id, toolName: TRACE_TOOL, args: { text: m.text }, result: "done" }] };
  }
  // Only the stored server raster flag permits previews; older attachments remain downloads.
  const attachments = m.role === "user" && m.files?.length ? { attachments: m.files.map((f) => ({ id: f.id, type: f.image === true ? "image" : "file", name: f.name, status: { type: "complete" as const }, content: f.image === true ? [{ type: "image" as const, image: `/files/${encodeURIComponent(f.id)}` }] : [] })) } : {};
  return { id: m.id, role: m.role, createdAt, content: [{ type: "text", text: m.text }], ...attachments };
}

function ofQuestion(q: Question): ThreadMessageLike {
  return {
    id: questionMessageId(q.id),
    role: "assistant",
    createdAt: new Date(q.createdAt),
    content: [{ type: "tool-call", toolCallId: q.id, toolName: QUESTION_TOOL, args: { questionId: q.id }, ...(q.status === "answered" && q.answer ? { result: q.answer } : {}) }],
  };
}

function ofConsult(q: Question): ThreadMessageLike {
  return { id: questionMessageId(q.id), role: "assistant", createdAt: new Date(q.createdAt), content: [{ type: "tool-call", toolCallId: q.id, toolName: CONSULT_TOOL, args: { questionId: q.id }, ...(q.status === "answered" ? { result: "done" } : {}) }] };
}

function kept<T extends object>(row: T, make: (row: T) => ThreadMessageLike): ThreadMessageLike {
  let message = converted.get(row);
  if (!message) converted.set(row, (message = make(row)));
  return message;
}

/**
 * The chat of a run as a thread: the chat step's messages and its questions (but those that
 * expired), in the order they came. A consult is a line, not a question.
 */
export function threadMessages(run: RunSnapshot | null, chatStepId: string | undefined): ThreadMessageLike[] {
  if (!run || !chatStepId) return [];
  return groupTraces([
    ...run.messages.filter((m) => m.stepRunId === chatStepId).map((m) => ({ at: new Date(m.createdAt).getTime(), message: kept(m, ofMessage) })),
    // A consult asks nothing of the owner: it shows as a line, with nothing to answer.
    ...run.questions.filter((q) => q.stepRunId === chatStepId && q.status !== "expired").map((q) => ({ at: new Date(q.createdAt).getTime(), message: kept(q, q.payload.kind === "consult" ? ofConsult : ofQuestion) })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((item) => item.message));
}

/** Consecutive trace rows become consecutive tool parts for the library's grouped renderer. */
function groupTraces(messages: ThreadMessageLike[]): ThreadMessageLike[] {
  const grouped: ThreadMessageLike[] = [];
  const isTrace = (message: ThreadMessageLike) => message.role === "assistant" && Array.isArray(message.content) && message.content.length > 0 && message.content.every((part) => part.type === "tool-call" && part.toolName === TRACE_TOOL);
  for (const message of messages) {
    const previous = grouped.at(-1);
    if (previous && isTrace(previous) && isTrace(message) && Array.isArray(previous.content) && Array.isArray(message.content)) {
      grouped[grouped.length - 1] = { ...previous, content: [...previous.content, ...message.content] };
    } else grouped.push(message);
  }
  return grouped;
}

const same = (m: ThreadMessageLike) => m;

/** The text of what the owner sent from the composer. */
export const textOf = (message: AppendMessage) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/**
 * The library's runtime over a run's chat. `canSend`: false while the conversation cannot continue or a question waits; `onSend` sends the
 * owner's words through Dispand's own procedures.
 */
/**
 * The composer's attachments: each file is held by Dispand as it is added (`hold`, `files.hold`),
 * under the id the message sends later; removing it from the composer leaves it to the sweep.
 */
export function heldAttachments(hold: (file: File) => Promise<{ id: string; image: boolean }>): AttachmentAdapter {
  return {
    accept: "*",
    async *add({ file }): AsyncGenerator<PendingAttachment & { heldId?: string }> {
      const pending: PendingAttachment = { id: crypto.randomUUID(), type: "file", name: file.name, file, content: [], status: { type: "running", reason: "uploading", progress: 0 } };
      yield pending;
      const held = await hold(file);
      // Only the server's raster sniff permits a preview; never trust the browser's MIME.
      yield { ...pending, heldId: held.id, type: held.image ? "image" : "file", content: held.image ? [{ type: "image", image: `/files/${encodeURIComponent(held.id)}` }] : [], status: { type: "requires-action", reason: "composer-send" } };
    },
    async remove() {},
    async send(attachment) {
      const id = (attachment as PendingAttachment & { heldId?: string }).heldId;
      if (!id) throw new Error("Attachment has not finished uploading");
      return { ...attachment, id, status: { type: "complete" }, content: attachment.content ?? [] };
    },
  };
}

/** What the owner does with the chat's queued messages, through Dispand's procedures; `steer`: send it now, into the running turn. */
export type QueueActions = { send: (message: AppendMessage) => void; steer: (queuedId: string) => void; edit: (queuedId: string, text: string) => void; remove: (queuedId: string) => void };

const queueItems = new WeakMap<object, QueueItemState>();
const ofQueued = (q: Queued): QueueItemState => ({ id: q.id, prompt: q.text, parts: [{ type: "text", text: q.text }] });

/**
 * The chat's queued messages as the library's queue (`ComposerPrimitive.Queue`). The server keeps
 * them and decides what waits, so both lanes send the same way, and no item moves ahead of
 * another here. While a turn runs or items wait, the composer sends through it; otherwise
 * through `onNew`, which gives a failed draft back.
 */
function queueOf(run: RunSnapshot | null, chatStepId: string | undefined, running: boolean, actions: QueueActions | undefined): ExternalThreadQueueAdapter | undefined {
  const items = (run?.queue ?? []).filter((q) => q.stepRunId === chatStepId).map((q) => {
    let item = queueItems.get(q);
    if (!item) queueItems.set(q, (item = ofQueued(q)));
    return item;
  });
  if (!actions || (!running && items.length === 0)) return undefined;
  // `QueueItemPrimitive.Steer` moves an item to the steer lane: the server sends it now. No other move reorders the server's queue.
  return { items, steerItems: [], enqueue: actions.send, steer: actions.send, move: (id, placement) => { if (placement.lane === "steer") actions.steer(id); }, edit: (id, message) => actions.edit(id, textOf(message)), remove: actions.remove };
}

export function useRunThread(options: { run: RunSnapshot | null; chatStepId: string | undefined; canSend: boolean; onSend: (message: AppendMessage) => Promise<void>; onCancel?: () => Promise<void>; attachments?: AttachmentAdapter; suggestions?: ThreadSuggestion[]; queue?: QueueActions }) {
  const isRunning = options.run?.steps.find((step) => step.id === options.chatStepId)?.turnStatus === "running";
  return useExternalStoreRuntime({
    messages: threadMessages(options.run, options.chatStepId),
    convertMessage: same,
    suggestions: options.suggestions,
    isRunning,
    onCancel: options.onCancel,
    isSendDisabled: !options.canSend,
    onNew: options.onSend,
    queue: queueOf(options.run, options.chatStepId, isRunning, options.queue),
    ...(options.attachments ? { adapters: { attachments: options.attachments } } : {}),
  });
}

/** A step's messages as a thread nobody writes to: the run page's transcript. */
export function useTranscript(messages: readonly Message[]) {
  return useExternalStoreRuntime({ messages: groupTraces(messages.map((m) => kept(m, ofMessage))), convertMessage: same, isDisabled: true, onNew: async () => {} });
}
