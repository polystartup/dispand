import { ActionBarPrimitive, AuiConfig, AuiIf, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, SelectionToolbarPrimitive, SuggestionPrimitive, Tools, groupPartByType, type AppendMessage, type AssistantRuntime, type TextMessagePartComponent, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { SHORT, type Answer } from "@dispand/runner-protocol";
import type { RecordResult } from "@dispand/domain/messages/record-result.ts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Check, ChevronDown, Copy, MessageSquare, Quote, Users, Wrench, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useTranslation } from "react-i18next";
import { createContext, type ComponentProps, type ReactNode, type Ref, useCallback, useContext, useId, useMemo, useRef, useState } from "react";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { ARTIFACT_TOOL, CONSULT_TOOL, heldAttachments, QUESTION_TOOL, RECORD_TOOL, threadMessages, TRACE_TOOL, useRunThread, useTranscript } from "../../lib/assistant-runtime.ts";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { ProposalItems } from "../questions/ProposalItems.tsx";
import { approvalWords, QuestionForm } from "../questions/QuestionForm.tsx";
import { Button } from "../ui/button.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { AgentText } from "./AgentText.tsx";
import { ArtifactPart, DraftPrompt } from "./ArtifactPart.tsx";
import { MessageAttachment } from "./Attachment.tsx";

type Question = RunSnapshot["questions"][number];

/** Stop can withdraw a proposal in the same conversation. */
export const turnActionKey = (runId: string | null | undefined, action: "stop" | "proposal") => ["chat-turn", runId, action];

/** The chat's questions by id: a question's part of the thread only carries its id. */
const Questions = createContext<Map<string, Question>>(new Map());
const bubble = "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-[15px] leading-relaxed";

const OwnerText: TextMessagePartComponent = ({ text }) => (
  <div className="flex justify-end">
    <p data-aui-quote-selectable className={`${bubble} bg-hover text-fg`}>{text}</p>
  </div>
);

/** A tool the agent used: one quiet line. */
const Trace: ToolCallMessagePartComponent<{ text: string }> = ({ args }) => (
  <p className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-muted">
    <Wrench size={14} className="mt-0.5 shrink-0" aria-hidden />
    <span className="min-w-0 whitespace-pre-wrap break-words">{args.text}</span>
  </p>
);

/** Display the saved result only: opening history never re-reads or changes a record. */
const RecordPart: ToolCallMessagePartComponent<{ id: string }, RecordResult> = ({ result }) => {
  const { t } = useTranslation("chat");
  if (!result) return null;
  const valueText = (value: RecordResult["fields"][number]["value"]) => value === null ? t("recordEmpty") : typeof value === "boolean" ? t(value ? "recordYes" : "recordNo") : Array.isArray(value) ? value.join("\n") || t("recordEmpty") : String(value);
  return <Collapsible.Root defaultOpen className="rounded-xl border border-line bg-surface text-[13px]">
    <Collapsible.Trigger className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left font-medium hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
      <span>{t("recordResult")}</span><ChevronDown size={16} aria-hidden />
    </Collapsible.Trigger>
    <Collapsible.Content className="rounded-b-xl bg-soft">
      {result.fields.length ? <dl className="space-y-3 border-t border-line px-3 py-3">
        {result.fields.map((field) => <div key={field.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
          <dt className="whitespace-pre-wrap break-words text-muted">{field.name}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{valueText(field.value)}</dd>
        </div>)}
      </dl> : <p className="border-t border-line px-3 py-3 text-muted">{t("recordNoFields")}</p>}
    </Collapsible.Content>
  </Collapsible.Root>;
};

/** A consult of the chat's agent, as one quiet line naming the agent it asks: the owner answers nothing. */
const ConsultPart: ToolCallMessagePartComponent<{ questionId: string }> = ({ args }) => {
  const { t } = useTranslation("chat");
  const q = useContext(Questions).get(args.questionId);
  const agents = useQuery(orpc.agents.list.queryOptions());
  const consultedId = q?.payload.kind === "consult" ? q.payload.agentId : undefined;
  const now = agents.data?.find((a) => a.id === consultedId)?.name;
  // A deleted agent is named as its consulted Job kept it: "Order drafter (Deleted)".
  const consults = useQuery({ ...orpc.jobs.consults.queryOptions({ input: { runId: q?.runId ?? "" } }), enabled: !!q && !!agents.data && !now });
  if (!q || q.payload.kind !== "consult") return null;
  const agent = now ?? (agents.data ? (consults.data?.asked.find((c) => c.questionId === q.id)?.agent ?? t("deletedAgent")) : t("otherAgent"));
  const failed = q.status === "answered" && q.answer?.kind === "consult" && q.answer.outcome === "failed";
  const text = q.status === "pending" ? t("consulting", { agent }) : failed ? t("noAnswerFrom", { agent }) : t("consulted", { agent });
  return (
    <p className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-muted">
      <Users size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
};

function useAnsweredText() {
  const { t } = useTranslation("chat");
  const format = useFormat();
  return (q: Question): string => {
    const a = q.answer;
    if (!a) return t("answered");
    if (a.kind === "choice") return t("youAnswered", { answers: format.list(Object.values(a.answers).flat()) });
    if (a.kind === "permission" && q.proposalId) return a.decision === "deny" ? (a.message ? t("declinedWith", { message: a.message }) : t("declined")) : t("approved");
    if (a.kind === "permission") return a.decision === "deny" ? t("denied") : t("allowed");
    if (a.kind === "consult") return a.outcome === "answered" ? t("consultAnswered") : t("consultNone");
    return a.confirmed ? t("goAhead") : t("notYet");
  };
}

/** A question of the chat, answered here or in the Inbox (whichever comes first). The answer goes through `questions.answer`, as everywhere. */
const QuestionPart: ToolCallMessagePartComponent<{ questionId: string }> = ({ args }) => {
  const { t } = useTranslation("chat");
  const answeredText = useAnsweredText();
  const q = useContext(Questions).get(args.questionId);
  const queryClient = useQueryClient();
  const stop = { mutationKey: turnActionKey(q?.runId, "stop") };
  const stopping = useIsMutating(stop) > 0;
  const card = useRef<HTMLElement>(null);
  const [conflict, setConflict] = useState(false);
  const answer = useMutation({
    ...orpc.questions.answer.mutationOptions({
      onError: (err) => setConflict((err as { code?: string }).code === "CONFLICT"),
      onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.questions.key() }),
    }),
    ...(q?.proposal && { mutationKey: turnActionKey(q.runId, "proposal") }),
  });
  if (!q) return null;
  const onAnswer = (value: Answer) => {
    if (q.proposal && queryClient.isMutating(stop)) return;
    // The submitted control disappears when the run publishes its decision.
    card.current?.focus({ preventScroll: true });
    answer.mutate({ questionId: q.id, answer: value });
  };
  if (q.proposalId && q.proposal) return (
    <ProposalCard question={q} ref={card}>
      {q.status === "pending" && (conflict ? <p role="status">{t("conflict")}</p> : <>
        <ProposalDecisions busy={stopping || answer.isPending || answer.isSuccess} onAnswer={onAnswer} />
        {answer.error && <p role="alert" className="text-[13px] text-danger">{answer.error.message}</p>}
      </>)}
    </ProposalCard>
  );
  if (q.status === "answered") return <p className="px-1 text-right text-[12px] text-faint">{answeredText(q)}</p>;
  return (
    <div className="mr-6 rounded-2xl border border-line bg-surface p-4">
      {conflict ? (
        <p role="status" className="text-[14px] text-muted">
          {t("conflict")}
        </p>
      ) : (
        <QuestionForm
          question={q}
          busy={answer.isPending}
          error={answer.error && !conflict ? answer.error.message : null}
          onAnswer={onAnswer}
        />
      )}
    </div>
  );
};

/** A proposal's Approval in the chat: every item whole, and the agent's words. Never cut: the thread scrolls. */
function ProposalCard({ question, children, ref }: { question: Question; children: ReactNode; ref: Ref<HTMLElement> }) {
  const { t } = useTranslation(["chat", "questions"]);
  const asked = approvalWords(question.payload);
  const answeredText = useAnsweredText();
  const answered = question.status === "answered";
  return (
    <section ref={ref} tabIndex={-1} aria-label={t("proposal")} className="mr-6 flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] rounded-2xl border border-line bg-surface p-4">
      <p className="text-[15px]">{answered ? answeredText(question) : t("questions:proposal.intro")}</p>
      <ProposalItems proposal={question.proposal!} />
      {asked !== null && (
        <>
          <p className="text-[13px] text-muted">{t("questions:proposal.says")}</p>
          <p className="whitespace-pre-wrap break-words text-[15px]">{asked}</p>
        </>
      )}
      {children}
    </section>
  );
}

function ProposalDecisions({ busy, onAnswer }: { busy: boolean; onAnswer: (value: Answer) => void }) {
  const { t } = useTranslation(["questions", "common"]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  const format = useFormat();
  const message = feedback?.trim() ?? "";
  const tooLong = message.length > SHORT;
  function cancel() {
    setFeedback(null);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || feedback !== null} onClick={() => onAnswer({ kind: "permission", decision: "allow" })}>{t("approve")}</Button>
        <Button ref={trigger} variant="outline" disabled={busy} aria-expanded={feedback !== null} aria-controls={feedback !== null ? editorId : undefined} onClick={() => feedback === null ? setFeedback("") : cancel()}>{t("proposal.requestChanges")}</Button>
        <Button variant="ghost" disabled={busy || feedback !== null} onClick={() => onAnswer({ kind: "permission", decision: "deny" })}>{t("proposal.decline")}</Button>
      </div>
      {feedback !== null && <form id={editorId} className="space-y-2 rounded-lg bg-soft p-3" onKeyDown={(e) => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing && !busy) { e.preventDefault(); cancel(); }
      }} onSubmit={(e) => {
        e.preventDefault();
        if (!busy && message && !tooLong) onAnswer({ kind: "permission", decision: "deny", message });
      }}>
        <label className="block space-y-2">
          <span>{t("proposal.feedback")}</span>
          <Textarea autoFocus disabled={busy} aria-invalid={tooLong || undefined} aria-describedby={tooLong ? `${editorId}-limit` : undefined} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </label>
        {tooLong && <p id={`${editorId}-limit`} role="alert" className="text-sm text-danger">{t("proposal.feedbackTooLong", { max: format.number(SHORT) })}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !message || tooLong}>{t("proposal.sendFeedback")}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>{t("common:actions.cancel")}</Button>
        </div>
      </form>}
    </>
  );
}

/** Copy only text messages: tool traces and questions have their own controls. */
function MessageActions() {
  const { t } = useTranslation("chat");
  return (
  <AuiIf condition={(s) => s.message.content.some((part) => part.type === "text" && part.text.length > 0)}>
    <ActionBarPrimitive.Root className="mt-1 flex">
      <ActionBarPrimitive.Copy aria-label={t("copyMessage")} title={t("copyMessage")} className="group grid size-11 place-items-center rounded-lg text-faint hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
        <Copy size={14} aria-hidden className="group-data-[copied=true]:hidden" />
        <Check size={14} aria-hidden className="hidden group-data-[copied=true]:block" />
        <AuiIf condition={(s) => s.message.isCopied}><span className="sr-only" role="status">{t("copied")}</span></AuiIf>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  </AuiIf>
  );
}

/** Standard composer input; the runtime owns text, quotes, files and submission. */
export function ChatInput(props: Omit<ComponentProps<typeof ComposerPrimitive.Input>, "submitOnEnter" | "submitMode">) {
  return <ComposerPrimitive.Input maxRows={6} submitMode="enter" cancelOnEscape={false} addAttachmentOnPaste {...props} />;
}

export function ComposerQuote() {
  const { t } = useTranslation("chat");
  return <ComposerPrimitive.Quote aria-label={t("quotedText")} className="order-first flex w-full items-start gap-2 rounded-lg bg-hover p-3 text-sm text-muted">
    <Quote size={16} className="mt-0.5 shrink-0" aria-hidden />
    <ComposerPrimitive.QuoteText className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words" />
    <ComposerPrimitive.QuoteDismiss aria-label={t("removeQuote")} title={t("removeQuote")} className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent"><X size={16} aria-hidden /></ComposerPrimitive.QuoteDismiss>
  </ComposerPrimitive.Quote>;
}

const OwnerMessage = () => (
  <MessagePrimitive.Root role="listitem">
    <div className="mb-1 flex flex-wrap justify-end gap-1.5 empty:hidden">
      <MessagePrimitive.Attachments components={{ Attachment: MessageAttachment }} />
    </div>
    <MessagePrimitive.Parts components={{ Text: OwnerText }} />
    <div className="flex justify-end"><MessageActions /></div>
  </MessagePrimitive.Root>
);

// Only routine trace names collapse; questions, approvals and consults stay standalone.
const groupBy = groupPartByType({ [`tool-call:${TRACE_TOOL}`]: ["group-tool"] });
const toolConfig = AuiConfig({ tools: Tools({ toolkit: {
  [TRACE_TOOL]: { type: "backend", render: Trace },
  [RECORD_TOOL]: { type: "backend", display: "standalone", render: RecordPart },
  [ARTIFACT_TOOL]: { type: "backend", display: "standalone", render: ArtifactPart },
  [QUESTION_TOOL]: { type: "backend", display: "standalone", render: QuestionPart },
  [CONSULT_TOOL]: { type: "backend", display: "standalone", render: ConsultPart },
} }) });

function ToolGroup({ group, children }: { group: MessagePrimitive.GroupedParts.GroupPart; children: ReactNode }) {
  const { t } = useTranslation("chat");
  if (group.indices.length === 1) return children;
  return (
    <Collapsible.Root className="rounded-xl border border-line bg-surface text-[13px] text-muted">
      <Collapsible.Trigger className="group flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
        <Wrench size={14} aria-hidden />
        <span className="flex-1">{t("toolActivity", { count: group.indices.length })}</span>
        <ChevronDown size={14} aria-hidden className="transition-transform group-data-[state=open]:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Content className="flex flex-col gap-1 rounded-b-xl bg-soft p-3">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

const AgentMessage = () => (
  <MessagePrimitive.Root role="listitem">
    <MessagePrimitive.GroupedParts groupBy={groupBy}>
      {({ part, children }) => {
        switch (part.type) {
          case "group-tool": return <ToolGroup group={part}>{children}</ToolGroup>;
          case "text": return <AgentText />;
          case "tool-call": return part.toolUI;
          default: return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
    <MessageActions />
  </MessagePrimitive.Root>
);

type Props = {
  runtime?: AssistantRuntime;
  run: RunSnapshot | null;
  chatStepId: string | undefined;
  canSend: boolean;
  canDraft?: boolean;
  onSend: (message: AppendMessage) => Promise<void>;
  /** Holds a file attached in the composer (`files.hold`): absent, the composer takes no file. */
  onAttach?: (file: File) => Promise<{ id: string; image: boolean }>;
  /** What follows the messages inside the scrolling area: the failure, the steps after the chat. */
  children?: ReactNode;
  composer?: ReactNode;
  starterPrompts?: boolean;
  /** The invitation an empty conversation shows in place of the plain hello. */
  welcome?: string;
  centeredWelcome?: boolean;
};

/** The conversation of a run's chat step, on assistant-ui's thread: the owner's and the agent's words, the tools it used, its questions. */
export function ChatThread(props: Props) {
  return props.runtime ? <ChatThreadView {...props} runtime={props.runtime} /> : <LocalChatThread {...props} />;
}

function LocalChatThread(props: Props) {
  const { run, chatStepId, canSend, onSend, onAttach, starterPrompts } = props;
  const { t } = useTranslation("chat");
  const attachments = useMemo(() => (onAttach ? heldAttachments(onAttach) : undefined), [onAttach]);
  const runtime = useRunThread({ run, chatStepId, canSend, onSend, suggestions: starterPrompts ? [
    { title: t("starterAgent"), prompt: t("starterAgentPrompt") },
    { title: t("starterReview"), prompt: t("starterReviewPrompt") },
  ] : [], ...(attachments ? { attachments } : {}) });
  return <ChatThreadView {...props} runtime={runtime} />;
}

function ChatThreadView({ runtime, run, chatStepId, canSend, canDraft = canSend, children, composer, welcome, centeredWelcome, starterPrompts }: Props & { runtime: AssistantRuntime }) {
  const { t } = useTranslation("chat");
  // Nothing said yet, and nothing went wrong: the invitation to start.
  const empty = threadMessages(run, chatStepId).length === 0 && run?.steps.find((s) => s.id === chatStepId)?.status !== "failed";
  const questions = new Map((run?.questions ?? []).map((q) => [q.id, q]));
  // An artifact's prompt goes after the draft, as the owner's words given back do (`ChatPanel`).
  const draft = useCallback((text: string) => {
    const composer = runtime.thread.composer;
    const current = composer.getState().text;
    composer.setText(current.trim() ? `${current}\n\n${text}` : text);
  }, [runtime]);
  return (
    <AssistantRuntimeProvider runtime={runtime} config={toolConfig}>
      <DraftPrompt.Provider value={canDraft && composer ? draft : undefined}>
      <Questions.Provider value={questions}>
          <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport className={centeredWelcome ? `flex min-h-0 flex-1 flex-col overflow-y-auto pt-6 ${empty ? "justify-center-safe" : ""}` : "min-h-0 flex-1 overflow-y-auto px-4 py-6"} aria-live="polite">
              {empty && <div className="flex min-h-36 shrink-0 flex-col items-center justify-center gap-3 px-4 text-center text-muted">
                {!centeredWelcome && <MessageSquare size={28} className="text-accent" aria-hidden />}
                {welcome ? (
                  <><p className="text-balance text-[23px] leading-tight font-medium tracking-[-0.025em] text-fg sm:text-[25px]">{t("howCanIHelp")}</p><p className="max-w-md text-sm">{welcome}</p></>
                ) : (
                  <>
                    <p className="text-[16px] font-medium text-fg">{t("sayHello")}</p>
                    <p className="max-w-64 text-[13px]">{t("sayHelloText")}</p>
                  </>
                )}
                {starterPrompts && canSend && <AuiIf condition={(s) => !s.composer.text && !s.composer.quote}>
                  <div className="flex flex-wrap justify-center gap-2 px-4">
                    <ThreadPrimitive.Suggestions>{() => <SuggestionPrimitive.Trigger send={false} className="min-h-11 rounded-lg border border-input px-3 py-2 text-sm text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"><SuggestionPrimitive.Title /></SuggestionPrimitive.Trigger>}</ThreadPrimitive.Suggestions>
                  </div>
                </AuiIf>}
              </div>}
              <div role="list" className={`mx-auto flex w-full max-w-3xl flex-col gap-5 ${centeredWelcome ? "px-4" : ""}`}>
                <ThreadPrimitive.Messages components={{ UserMessage: OwnerMessage, AssistantMessage: AgentMessage }} />
              </div>
              <div className={`mx-auto w-full max-w-3xl ${centeredWelcome ? "px-4" : ""}`}>
                {children}
              </div>
              {centeredWelcome ? <ThreadPrimitive.ViewportFooter className={`z-10 shrink-0 pt-4 ${empty ? "" : "sticky bottom-0 mt-auto bg-surface"}`}>
                <div className="relative flex justify-center">
                  <ThreadPrimitive.ScrollToBottom aria-label={t("jump")} title={t("jump")} className="absolute bottom-2 grid size-11 place-items-center rounded-full border border-line bg-surface p-2 text-fg shadow-md disabled:invisible"><ArrowDown size={18} aria-hidden /></ThreadPrimitive.ScrollToBottom>
                </div>
                {composer}
              </ThreadPrimitive.ViewportFooter> : <div className="sticky bottom-0 flex h-0 justify-center">
                <ThreadPrimitive.ScrollToBottom aria-label={t("jump")} title={t("jump")} className="absolute bottom-0 grid size-11 place-items-center rounded-full border border-line bg-surface p-2 text-fg shadow-md disabled:invisible"><ArrowDown size={18} aria-hidden /></ThreadPrimitive.ScrollToBottom>
              </div>}
            </ThreadPrimitive.Viewport>
            {!centeredWelcome && composer}
            {canDraft && composer && <SelectionToolbarPrimitive.Root className="z-50 rounded-lg border border-line bg-surface p-1 shadow-md">
              <SelectionToolbarPrimitive.Quote className="flex min-h-11 items-center gap-2 rounded px-3 py-2 text-sm text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"><Quote size={16} aria-hidden />{t("quoteReply")}</SelectionToolbarPrimitive.Quote>
            </SelectionToolbarPrimitive.Root>}
          </ThreadPrimitive.Root>
      </Questions.Provider>
      </DraftPrompt.Provider>
    </AssistantRuntimeProvider>
  );
}

/** A step's conversation on the run page, read-only: the chat's messages without its composer. Its questions show in their own section. */
export function ChatTranscript({ messages }: { messages: RunSnapshot["messages"] }) {
  const runtime = useTranscript(messages);
  return (
    <AssistantRuntimeProvider runtime={runtime} config={toolConfig}>
      <ThreadPrimitive.Root>
        <div role="list" className="flex flex-col gap-4">
          <ThreadPrimitive.Messages components={{ UserMessage: OwnerMessage, AssistantMessage: AgentMessage }} />
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
