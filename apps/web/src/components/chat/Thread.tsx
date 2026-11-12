import { ActionBarPrimitive, AuiIf, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, type TextMessagePartComponent, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { Answer } from "@dispand/runner-protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Check, Copy, MessageSquare, Users, Wrench } from "lucide-react";
import { createContext, type ComponentProps, type ReactNode, useContext, useState } from "react";
import { orpc } from "../../lib/api.ts";
import { CONSULT_TOOL, QUESTION_TOOL, threadMessages, TRACE_TOOL, useRunThread } from "../../lib/assistant-runtime.ts";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { ProposalItems } from "../questions/ProposalItems.tsx";
import { approvalWords, QuestionForm } from "../questions/QuestionForm.tsx";
import { AgentText } from "./AgentText.tsx";

type Question = RunSnapshot["questions"][number];

/**
 * The proposal Approval the chat's composer answers (Approve, or words that decline it): only
 * when it is the one question of the chat that waits, and its items can be shown. With more than
 * one waiting, each is answered on its own card, so a click can't go to another than the one read.
 */
export function composerApproval(questions: readonly Question[], chatStepId: string | undefined): Question | undefined {
  const pending = questions.filter((q) => q.stepRunId === chatStepId && q.status === "pending");
  const [only] = pending;
  return pending.length === 1 && only!.proposalId && only!.proposal ? only : undefined;
}

/** The chat's questions by id: a question's part of the thread only carries its id. */
const Questions = createContext<Map<string, Question>>(new Map());
/** The id of the proposal Approval the composer answers (`composerApproval`). */
const ComposerApproval = createContext<string | undefined>(undefined);

const bubble = "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-[15px] leading-relaxed";

const OwnerText: TextMessagePartComponent = ({ text }) => (
  <div className="flex justify-end">
    <p className={`${bubble} rounded-br-md bg-accent text-accent-fg`}>{text}</p>
  </div>
);

/** A tool the agent used: one quiet line. */
const Trace: ToolCallMessagePartComponent<{ text: string }> = ({ args }) => (
  <p className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-muted">
    <Wrench size={14} className="mt-0.5 shrink-0" aria-hidden />
    <span className="min-w-0 whitespace-pre-wrap break-words">{args.text}</span>
  </p>
);

/** A consult of the chat's agent, as one quiet line naming the agent it asks: the owner answers nothing. */
const ConsultPart: ToolCallMessagePartComponent<{ questionId: string }> = ({ args }) => {
  const q = useContext(Questions).get(args.questionId);
  const agents = useQuery(orpc.agents.list.queryOptions());
  const consultedId = q?.payload.kind === "consult" ? q.payload.agentId : undefined;
  const now = agents.data?.find((a) => a.id === consultedId)?.name;
  // A deleted agent is named as its consulted Job kept it: "Order drafter (Deleted)".
  const consults = useQuery({ ...orpc.jobs.consults.queryOptions({ input: { runId: q?.runId ?? "" } }), enabled: !!q && !!agents.data && !now });
  if (!q || q.payload.kind !== "consult") return null;
  const agent = now ?? (agents.data ? (consults.data?.asked.find((c) => c.questionId === q.id)?.agent ?? "a deleted agent") : "another agent");
  const failed = q.status === "answered" && q.answer?.kind === "consult" && q.answer.outcome === "failed";
  const text = q.status === "pending" ? `Consulting ${agent}…` : failed ? `${agent} gave no answer` : `Consulted ${agent}`;
  return (
    <p className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-muted">
      <Users size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
};

function answeredText(q: Question): string {
  const a = q.answer;
  if (!a) return "Answered";
  if (a.kind === "choice") return `You answered ${Object.values(a.answers).flat().join(", ")}`;
  if (a.kind === "permission" && q.proposalId) return a.decision === "deny" ? `You declined it${a.message ? `: ${a.message}` : ""}` : "You approved it";
  if (a.kind === "permission") return a.decision === "deny" ? "You denied it" : "You allowed it";
  if (a.kind === "consult") return a.outcome === "answered" ? "Answered by the agent consulted" : "No answer";
  return a.confirmed ? "You said go ahead" : "You said not yet";
}

/** A question of the chat, answered here or in the Inbox (whichever comes first). The answer goes through `questions.answer`, as everywhere. */
const QuestionPart: ToolCallMessagePartComponent<{ questionId: string }> = ({ args }) => {
  const q = useContext(Questions).get(args.questionId);
  const inComposer = useContext(ComposerApproval) === args.questionId;
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const answer = useMutation(
    orpc.questions.answer.mutationOptions({
      onError: (err) => setConflict((err as { code?: string }).code === "CONFLICT"),
      onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.questions.key() }),
    }),
  );
  if (!q) return null;
  if (q.status === "answered") return <p className="px-1 text-right text-[12px] text-faint">{answeredText(q)}</p>;
  // A proposal shown whole: approved or declined from the composer (`ChatPanel`), its one control.
  if (inComposer) return <ProposalCard question={q} />;
  return (
    <div className="mr-6 rounded-2xl border border-line bg-surface p-4">
      {conflict ? (
        <p role="status" className="text-[14px] text-muted">
          This question was already answered elsewhere.
        </p>
      ) : (
        <QuestionForm
          question={q}
          busy={answer.isPending}
          error={answer.error && !conflict ? answer.error.message : null}
          onAnswer={(a: Answer) => answer.mutate({ questionId: q.id, answer: a })}
        />
      )}
    </div>
  );
};

/** A proposal's Approval in the chat: every item whole, and the agent's words. Never cut: the thread scrolls. */
function ProposalCard({ question }: { question: Question }) {
  const asked = approvalWords(question.payload);
  return (
    <section aria-label="Proposal" className="mr-6 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <p className="text-[15px]">The agent asks you to approve these changes. Approving lets it make exactly these, once each.</p>
      <ProposalItems proposal={question.proposal!} />
      {asked !== null && (
        <>
          <p className="text-[13px] text-muted">The agent says:</p>
          <p className="whitespace-pre-wrap break-words text-[15px]">{asked}</p>
        </>
      )}
      <p className="text-[13px] text-muted">Approve below, or write what should change: sending it declines these changes and tells the agent.</p>
    </section>
  );
}

/** Copy only text messages: tool traces and questions have their own controls. */
const MessageActions = () => (
  <AuiIf condition={(s) => s.message.content.some((part) => part.type === "text" && part.text.length > 0)}>
    <ActionBarPrimitive.Root className="mt-1 flex">
      <ActionBarPrimitive.Copy aria-label="Copy message" title="Copy message" className="group rounded-md p-2 text-faint hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
        <Copy size={14} aria-hidden className="group-data-[copied=true]:hidden" />
        <Check size={14} aria-hidden className="hidden group-data-[copied=true]:block" />
        <AuiIf condition={(s) => s.message.isCopied}><span className="sr-only" role="status">Copied</span></AuiIf>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  </AuiIf>
);

/** The panel owns the draft and delivery; the library supplies sizing and focus behavior. */
export function ChatInput(props: Omit<ComponentProps<typeof ComposerPrimitive.Input>, "submitOnEnter" | "submitMode">) {
  return <ComposerPrimitive.Input maxRows={6} submitMode="none" cancelOnEscape={false} addAttachmentOnPaste={false} {...props} />;
}

const OwnerMessage = () => (
  <MessagePrimitive.Root role="listitem">
    <MessagePrimitive.Parts components={{ Text: OwnerText }} />
    <div className="flex justify-end"><MessageActions /></div>
  </MessagePrimitive.Root>
);

const AgentMessage = () => (
  <MessagePrimitive.Root role="listitem">
    <MessagePrimitive.Parts components={{ Text: AgentText, tools: { by_name: { [TRACE_TOOL]: Trace, [QUESTION_TOOL]: QuestionPart, [CONSULT_TOOL]: ConsultPart } } }} />
    <MessageActions />
  </MessagePrimitive.Root>
);

type Props = {
  run: RunSnapshot | null;
  chatStepId: string | undefined;
  canSend: boolean;
  onSend: (text: string) => Promise<void>;
  /** What follows the messages inside the scrolling area: the failure, the steps after the chat. */
  children?: ReactNode;
  composer?: ReactNode;
  /** The invitation an empty conversation shows in place of the plain hello. */
  welcome?: string;
};

/** The conversation of a run's chat step, on assistant-ui's thread: the owner's and the agent's words, the tools it used, its questions. */
export function ChatThread({ run, chatStepId, canSend, onSend, children, composer, welcome }: Props) {
  const runtime = useRunThread({ run, chatStepId, canSend, onSend });
  // Nothing said yet, and nothing went wrong: the invitation to start.
  const empty = threadMessages(run, chatStepId).length === 0 && run?.steps.find((s) => s.id === chatStepId)?.status !== "failed";
  const questions = new Map((run?.questions ?? []).map((q) => [q.id, q]));
  const approval = composerApproval(run?.questions ?? [], chatStepId)?.id;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Questions.Provider value={questions}>
        <ComposerApproval.Provider value={approval}>
          <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4 py-6" aria-live="polite">
              {empty && <div className="flex min-h-36 flex-col items-center justify-center gap-3 text-center text-muted">
                <MessageSquare size={28} className="text-accent" aria-hidden />
                {welcome ? (
                  <p className="max-w-md text-[16px] font-medium text-fg">{welcome}</p>
                ) : (
                  <>
                    <p className="text-[16px] font-medium text-fg">Say hello to start.</p>
                    <p className="max-w-64 text-[13px]">Ask a question or describe what you want to get done.</p>
                  </>
                )}
              </div>}
              <div role="list" className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                <ThreadPrimitive.Messages components={{ UserMessage: OwnerMessage, AssistantMessage: AgentMessage }} />
              </div>
              <div className="mx-auto w-full max-w-3xl">
                {children}
              </div>
              <div className="sticky bottom-0 flex h-0 justify-center">
                <ThreadPrimitive.ScrollToBottom aria-label="Jump to latest message" title="Jump to latest message" className="absolute bottom-0 rounded-full border border-line bg-surface p-2 text-fg shadow-md disabled:invisible">
                  <ArrowDown size={18} aria-hidden />
                </ThreadPrimitive.ScrollToBottom>
              </div>
            </ThreadPrimitive.Viewport>
            {composer}
          </ThreadPrimitive.Root>
        </ComposerApproval.Provider>
      </Questions.Provider>
    </AssistantRuntimeProvider>
  );
}
