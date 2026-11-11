import { nodesOf, type WorkflowDef } from "@dispand/domain/workflows/model";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, CircleAlert, Loader2, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { useRun } from "../../lib/run-watch.ts";
import { ChatThread } from "../chat/Thread.tsx";

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

  /** The library's composer path (not shown today: the panel keeps its own, which keeps a draft that failed to send). */
  const sendText = async (words: string) => {
    if (runId) await api.runs.sendChat({ runId, text: words });
  };

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
      <ChatThread run={run} chatStepId={chatStep?.id} working={chatStep?.status === "running"} canSend={canSend} onSend={sendText}>
        <AfterChat run={run} chatStepId={chatStep?.id} def={runDef} />
      </ChatThread>
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

/** Under the messages: why the conversation stopped, or the steps that follow it. */
function AfterChat({ run, chatStepId, def }: { run: RunSnapshot | null; chatStepId: string | undefined; def: WorkflowDef | undefined }) {
  const chatStep = run?.steps.find((s) => s.id === chatStepId);
  const followUps = run?.steps.filter((s) => s.id !== chatStepId) ?? [];
  return (
    <>
      {chatStep?.status === "failed" && (
        <p role="alert" className="mt-3 px-1 text-[13px] text-danger">
          The conversation stopped: {chatStep.error ?? run?.run.error ?? "the agent failed"}
        </p>
      )}
      {chatStep?.status === "succeeded" && run && <Progress run={run} steps={followUps} def={def} />}
    </>
  );
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
