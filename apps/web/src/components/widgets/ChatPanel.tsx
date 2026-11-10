import type { Answer } from "@dispand/runner-protocol";
import { nodesOf, type WorkflowDef } from "@dispand/domain/workflows/model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, CircleAlert, Loader2, MessageSquarePlus, Wrench } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, orpc } from "../../lib/api.ts";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { useRun } from "../../lib/run-watch.ts";
import { QuestionForm } from "../questions/QuestionForm.tsx";

type Question = RunSnapshot["questions"][number];
type Step = RunSnapshot["steps"][number];

type Props = {
  /** The workflow whose Chat field this is; absent for an agent's chat trigger, whose Job has its own definition. */
  workflowId?: string;
  /** Starts the conversation's run (default: a run of `workflowId`). */
  start?: () => Promise<{ runId: string }>;
  /** The conversation shown; null: a new one starts with the first message. */
  runId: string | null;
  onRunStarted: (runId: string) => void;
  onNewConversation: () => void;
};

/** A workflow's Chat field or an agent's chat trigger: the conversation with the agent, then the progress of the steps after it. */
export function ChatPanel({ workflowId, start, runId, onRunStarted, onNewConversation }: Props) {
  const run = useRun(runId);
  // Names and nodes as the run's version had them: the workflow may have changed since.
  const version = run?.run.version;
  const versionDef = useQuery({
    ...orpc.workflows.get.queryOptions({ input: { id: workflowId ?? "", version: version ?? 0 } }),
    enabled: !!workflowId && version !== undefined,
    staleTime: Infinity,
  }).data?.def;
  // A Job keeps its own definition.
  const jobDef = useQuery({
    ...orpc.jobs.def.queryOptions({ input: { runId: runId ?? "" } }),
    enabled: !workflowId && !!runId,
    staleTime: Infinity,
  }).data;
  const runDef = workflowId ? versionDef : jobDef;
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const chatStep = run?.steps.find((s) => s.interactive);
  // Until its stream answers, a run just started counts as open: the first message may still be on its way.
  const open = !runId || !run || (!!chatStep && (chatStep.status === "running" || chatStep.status === "waiting"));
  const asking = !!run?.questions.some((q) => q.stepRunId === chatStep?.id && q.status === "pending");
  const canSend = open && !asking;

  async function send() {
    const message = text.trim();
    if (!message || sending || !canSend) return;
    const submitted = text;
    setSending(true);
    setError(null);
    try {
      let id = runId;
      if (!id) {
        id = (await (start ? start() : api.runs.start({ workflowId: workflowId ?? "" }))).runId;
        onRunStarted(id);
        void queryClient.invalidateQueries({ queryKey: orpc.runs.list.key() });
      }
      await api.runs.sendChat({ runId: id, text: message });
      // Only the draft that was sent: what was typed meanwhile (or a new conversation) stays.
      setText((current) => (current === submitted ? "" : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the message");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Transcript run={run} chatStepId={chatStep?.id} def={runDef} />
      <div className="border-t border-line px-3 pb-3 pt-2">
        {error && (
          <p role="alert" className="mb-2 px-1 text-[13px] text-danger">
            {error}
          </p>
        )}
        {asking && <p className="mb-2 px-1 text-[13px] text-muted">Answer the question above to continue.</p>}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {runId && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="New conversation"
              title="New conversation"
              className="rounded-full text-muted"
              // Not while a message is on its way: its completion clears the draft of this conversation.
              disabled={sending}
              onClick={() => {
                setText("");
                setError(null);
                onNewConversation();
              }}
            >
              <MessageSquarePlus aria-hidden />
            </Button>
          )}
          <textarea
            aria-label="Message"
            rows={1}
            value={text}
            disabled={!canSend}
            placeholder={open ? "Message" : "This conversation is over"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            className="max-h-32 min-h-9 flex-1 resize-none rounded-[18px] border border-line bg-bg px-3.5 py-[7px] text-[15px] leading-5 outline-none placeholder:text-faint focus:border-accent disabled:opacity-60"
          />
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={!canSend || sending || !text.trim()} className="rounded-full">
            <ArrowUp aria-hidden />
          </Button>
        </form>
      </div>
    </div>
  );
}

function Transcript({ run, chatStepId, def }: { run: RunSnapshot | null; chatStepId: string | undefined; def: WorkflowDef | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const chatMessages = run?.messages.filter((m) => m.stepRunId === chatStepId) ?? [];
  const chatQuestions = run?.questions.filter((q) => q.stepRunId === chatStepId && q.status !== "expired") ?? [];
  // Messages and the chat's questions in the order they came.
  const items = [
    ...chatMessages.map((m) => ({ kind: "message" as const, at: new Date(m.createdAt).getTime(), m })),
    ...chatQuestions.map((q) => ({ kind: "question" as const, at: new Date(q.createdAt).getTime(), q })),
  ].sort((a, b) => a.at - b.at);
  const followUps = run?.steps.filter((s) => s.id !== chatStepId) ?? [];
  const chatStep = run?.steps.find((s) => s.id === chatStepId);
  const chatDone = chatStep?.status === "succeeded";
  const chatFailed = chatStep?.status === "failed";
  const lastSize = `${items.length}:${chatMessages.at(-1)?.text.length ?? 0}:${followUps.map((s) => s.status).join()}`;

  // The transcript's own scroll only: scrolling an element into view would move the whole page too.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastSize]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
      {items.length === 0 && !chatFailed && (
        <p className="grid h-full place-items-center text-center text-[14px] text-faint">Say hello to start.</p>
      )}
      <ol className="flex flex-col gap-2">
        {items.map((item) =>
          item.kind === "message" ? (
            <li key={item.m.id}>
              <Bubble role={item.m.role} text={item.m.text} />
            </li>
          ) : (
            <li key={item.q.id}>
              <InlineQuestion q={item.q} />
            </li>
          ),
        )}
      </ol>
      {chatFailed && (
        <p role="alert" className="mt-3 px-1 text-[13px] text-danger">
          The conversation stopped: {chatStep.error ?? run?.run.error ?? "the agent failed"}
        </p>
      )}
      {chatDone && run && <Progress run={run} steps={followUps} def={def} />}
    </div>
  );
}

function Bubble({ role, text }: { role: "assistant" | "user" | "tool"; text: string }) {
  if (role === "tool") {
    return (
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-faint">
        <Wrench size={12} aria-hidden />
        {text}
      </p>
    );
  }
  const mine = role === "user";
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <p
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2 text-[15px] leading-snug",
          mine ? "rounded-br-md bg-accent text-accent-fg" : "rounded-bl-md bg-hover text-fg",
        )}
      >
        {text}
      </p>
    </div>
  );
}

/** A question of the chat, answered here or in the Inbox (whichever comes first). */
function InlineQuestion({ q }: { q: Question }) {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const answer = useMutation(
    orpc.questions.answer.mutationOptions({
      onError: (err) => setConflict((err as { code?: string }).code === "CONFLICT"),
      onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.questions.key() }),
    }),
  );
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
}

function answeredText(q: Question): string {
  const a = q.answer;
  if (!a) return "Answered";
  if (a.kind === "choice") return `You answered ${Object.values(a.answers).flat().join(", ")}`;
  if (a.kind === "permission") return a.decision === "deny" ? "You denied it" : "You allowed it";
  return a.confirmed ? "You said go ahead" : "You said not yet";
}

const statusText = { pending: "Up next", running: "Working…", waiting: "Waiting for you in the Inbox", succeeded: "Finished", failed: "Failed", skipped: "Skipped" };

/** After the confirmation: the steps that follow, with their results. */
function Progress({ run, steps, def }: { run: RunSnapshot; steps: Step[]; def: WorkflowDef | undefined }) {
  const names = new Map(def ? nodesOf(def).map((n) => [n.id, n.name]) : []);
  return (
    <section aria-label="Progress" className="mt-4 flex flex-col gap-2 rounded-2xl bg-hover p-3">
      {steps.map((s) => (
        <div key={s.id} className="rounded-xl bg-surface px-3 py-2.5">
          <div className="flex items-center gap-2">
            <StepIcon status={s.status} />
            <p className="flex-1 text-[14px] font-medium">{names.get(s.nodeId) ?? "Step"}</p>
            <span className="text-[12px] text-muted">{statusText[s.status]}</span>
          </div>
          {s.status === "succeeded" && s.outputs && <Outputs outputs={s.outputs} />}
          {s.error && <p className="mt-1 text-[13px] text-danger">{s.error}</p>}
        </div>
      ))}
      <p className="px-1 pt-1 text-[13px] text-muted" role="status">
        {run.run.status === "succeeded" ? "All done" : run.run.status === "failed" ? `Stopped: ${run.run.error ?? "a step failed"}` : "Running"}
      </p>
    </section>
  );
}

function Outputs({ outputs }: { outputs: Record<string, string> }) {
  const entries = Object.entries(outputs);
  if (entries.length === 1 && entries[0]![0] === "result") {
    return <p className="mt-1.5 whitespace-pre-wrap text-[14px] text-fg">{entries[0]![1]}</p>;
  }
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="whitespace-pre-wrap">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function StepIcon({ status }: { status: Step["status"] }) {
  if (status === "succeeded") return <Check size={15} className="text-[#30d158]" aria-hidden />;
  if (status === "failed") return <CircleAlert size={15} className="text-danger" aria-hidden />;
  if (status === "pending" || status === "skipped") return <span aria-hidden className="mx-[3px] size-2 rounded-full bg-faint" />;
  return <Loader2 size={15} className="animate-spin text-accent" aria-hidden />;
}
