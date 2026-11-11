import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, type TextMessagePartComponent, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { Answer } from "@dispand/runner-protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { orpc } from "../../lib/api.ts";
import { QUESTION_TOOL, threadMessages, TRACE_TOOL, useRunThread } from "../../lib/assistant-runtime.ts";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { QuestionForm } from "../questions/QuestionForm.tsx";
import { AgentText } from "./AgentText.tsx";

type Question = RunSnapshot["questions"][number];

/** The chat's questions by id: a question's part of the thread only carries its id. */
const Questions = createContext<Map<string, Question>>(new Map());

const bubble = "max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2 text-[15px] leading-snug";

const OwnerText: TextMessagePartComponent = ({ text }) => (
  <div className="flex justify-end">
    <p className={`${bubble} rounded-br-md bg-accent text-accent-fg`}>{text}</p>
  </div>
);

/** A tool the agent used: one quiet line. */
const Trace: ToolCallMessagePartComponent<{ text: string }> = ({ args }) => (
  <p className="flex items-center gap-1.5 px-1 text-[12px] text-faint">
    <Wrench size={12} aria-hidden />
    {args.text}
  </p>
);

function answeredText(q: Question): string {
  const a = q.answer;
  if (!a) return "Answered";
  if (a.kind === "choice") return `You answered ${Object.values(a.answers).flat().join(", ")}`;
  if (a.kind === "permission") return a.decision === "deny" ? "You denied it" : "You allowed it";
  return a.confirmed ? "You said go ahead" : "You said not yet";
}

/** A question of the chat, answered here or in the Inbox (whichever comes first). The answer goes through `questions.answer`, as everywhere. */
const QuestionPart: ToolCallMessagePartComponent<{ questionId: string }> = ({ args }) => {
  const q = useContext(Questions).get(args.questionId);
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

const OwnerMessage = () => (
  <MessagePrimitive.Root role="listitem">
    <MessagePrimitive.Parts components={{ Text: OwnerText }} />
  </MessagePrimitive.Root>
);

const AgentMessage = () => (
  <MessagePrimitive.Root role="listitem">
    <MessagePrimitive.Parts components={{ Text: AgentText, tools: { by_name: { [TRACE_TOOL]: Trace, [QUESTION_TOOL]: QuestionPart } } }} />
  </MessagePrimitive.Root>
);

type Props = {
  run: RunSnapshot | null;
  chatStepId: string | undefined;
  /** The agent is at work. */
  working: boolean;
  canSend: boolean;
  onSend: (text: string) => Promise<void>;
  /** What follows the messages inside the scrolling area: the failure, the steps after the chat. */
  children?: ReactNode;
};

/** The conversation of a run's chat step, on assistant-ui's thread: the owner's and the agent's words, the tools it used, its questions. */
export function ChatThread({ run, chatStepId, working, canSend, onSend, children }: Props) {
  const runtime = useRunThread({ run, chatStepId, working, canSend, onSend });
  // Nothing said yet, and nothing went wrong: the invitation to start.
  const empty = threadMessages(run, chatStepId).length === 0 && run?.steps.find((s) => s.id === chatStepId)?.status !== "failed";
  const questions = new Map((run?.questions ?? []).map((q) => [q.id, q]));
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Questions.Provider value={questions}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
            {empty && <p className="grid h-full place-items-center text-center text-[14px] text-faint">Say hello to start.</p>}
            <div role="list" className="flex flex-col gap-2">
              <ThreadPrimitive.Messages components={{ UserMessage: OwnerMessage, AssistantMessage: AgentMessage }} />
            </div>
            {children}
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </Questions.Provider>
    </AssistantRuntimeProvider>
  );
}
