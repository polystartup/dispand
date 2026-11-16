import { AssistantInput } from "../assistant/AssistantInput.tsx";
import { nodesOf, type WorkflowDef } from "@dispand/domain/workflows/model";
import { SHORT } from "@dispand/runner-protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, CircleAlert, Loader2, MessageSquarePlus, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import { canReopen, type RunSnapshot } from "../../lib/run-state.ts";
import { useRun } from "../../lib/run-watch.ts";
import { ChatInput, ChatThread, ComposerAttachments, type ComposerFiles, composerApproval } from "../chat/Thread.tsx";
import { useStored } from "@/lib/message";

type Step = RunSnapshot["steps"][number];

type Props = {
  /** The workflow whose Chat field this is; absent for an agent's chat trigger, whose Job has its own definition. */
  workflowId?: string;
  /** Starts the conversation's run (default: a run of `workflowId`). */
  start?: (skillId?: string) => Promise<{ runId: string }>;
  /** The conversation shown; null: a new one starts with the first message. */
  runId: string | null;
  onRunStarted: (runId: string) => void;
  /** Absent: no new conversation can start (a disabled trigger's). */
  onNewConversation?: () => void;
  /** What an empty conversation invites the owner to say (default: a plain hello). */
  welcome?: string;
  composerTools?: ReactNode;
  assistantAgentId?: string;
};

/** A workflow's Chat field or an agent's chat trigger: the conversation with the agent, then the progress of the steps after it. */
export function ChatPanel({ workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId }: Props) {
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
  const [chosenSkill, setChosenSkill] = useState<{ name: string; skillId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { t } = useTranslation("chat");
  const { number } = useFormat();
  // The composer's attached files, each held by Dispand as it is added, sent with the next message.
  const files = useRef<ComposerFiles | null>(null);
  // Files still on their way: sending waits for them, so none is left for the next message.
  const [holding, setHolding] = useState(0);
  // Bumped when the draft's conversation changes: a file still on its way then joins no draft.
  const draft = useRef(0);
  const hold = useCallback(
    async (file: File) => {
      setHolding((n) => n + 1);
      const mine = draft.current;
      try {
        const held = await api.files.hold({ file });
        if (draft.current !== mine) throw new Error(t("attachFailed"));
        return held;
      } catch (err) {
        if (draft.current === mine) setError(err instanceof Error ? err.message : t("attachFailed"));
        throw err;
      } finally {
        setHolding((n) => n - 1);
      }
    },
    [t],
  );
  // The chat step, or, while it waits for a slot of its harness, the step of the run's chat field.
  const chatField = runDef?.trigger.field.type === "chat" ? runDef.trigger.field.id : undefined;
  const chatStep = run?.steps.find((s) => s.interactive) ?? run?.steps.find((s) => s.nodeId === chatField && s.status === "pending");
  // Until its stream answers, a run just started counts as open: the first message may still be on its way.
  const open = !runId || !run || canReopen(run) || (!!chatStep && (chatStep.status === "running" || chatStep.status === "waiting" || chatStep.status === "pending"));
  // A proposal's Approval shown whole in the thread, alone in waiting: the composer answers it,
  // Approve or the words typed, which decline it. Any other question is answered where it is
  // shown, and sending waits for it.
  const approval = composerApproval(run?.questions ?? [], chatStep?.id);
  const asking = !approval && !!run?.questions.some((q) => q.stepRunId === chatStep?.id && q.status === "pending");
  const canSend = open && !asking;

  // Another conversation opened from outside (a list, the URL) starts without this one's draft;
  // the one this panel started itself keeps what is still being typed.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (runId === started.current) {
      started.current = null;
      return;
    }
    setText("");
    setChosenSkill(null);
    setError(null);
    // Files attached for the other conversation stay with it: none goes with this one.
    draft.current++;
    if (files.current) void files.current.remove(files.current.ids());
  }, [runId]);

  /** The library's composer path (not shown today: the panel keeps its own, which keeps a draft that failed to send). */
  const sendText = async (words: string) => {
    if (runId) await api.runs.sendChat({ runId, text: words });
  };

  /** Answers the chat's proposal Approval: a person's click, or their words, which decline it. */
  async function answerApproval(answer: { decision: "allow" } | { decision: "deny"; message: string }) {
    if (!approval) return;
    await api.questions.answer({ questionId: approval.id, answer: { kind: "permission", ...answer } }).catch((err: unknown) => {
      if ((err as { code?: string }).code === "CONFLICT") throw new Error(t("conflictProposal"));
      throw err;
    }).finally(() => void queryClient.invalidateQueries({ queryKey: orpc.questions.key() }));
  }

  async function approve() {
    if (!approval || sending) return;
    setSending(true);
    setError(null);
    try {
      await answerApproval({ decision: "allow" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("approveFailed"));
    } finally {
      setSending(false);
    }
  }

  async function send() {
    const message = text.trim();
    if (!message || sending || !canSend || holding > 0) return;
    const skillId = chosenSkill && message.split(/\s/, 1)[0] === `/${chosenSkill.name}` ? chosenSkill.skillId : undefined;
    const submitted = text;
    setSending(true);
    setError(null);
    try {
      if (approval) {
        if (message.length > SHORT) throw new Error(t("tooLong", { max: number(SHORT) }));
        await answerApproval({ decision: "deny", message });
        setText((current) => (current === submitted ? "" : current));
        return;
      }
      let id = runId;
      if (!id) {
        id = (await (start ? start(skillId) : api.runs.start({ workflowId: workflowId ?? "" }))).runId;
        started.current = id;
        onRunStarted(id);
        void queryClient.invalidateQueries({ queryKey: orpc.runs.list.key() });
      }
      const attachmentIds = files.current?.ids() ?? [];
      await api.runs.sendChat({ runId: id, text: message, ...(skillId ? { skillId } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) });
      // Only the files that went: one attached meanwhile stays for the next message.
      if (attachmentIds.length) void files.current?.remove(attachmentIds);
      // The conversation's list now has its title.
      void queryClient.invalidateQueries({ queryKey: orpc.runs.list.key() });
      // Only the draft that was sent: what was typed meanwhile (or a new conversation) stays.
      setText((current) => (current === submitted ? "" : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sendFailed"));
    } finally {
      setSending(false);
    }
  }

  const composerInput = (
    <ChatInput
      aria-label={t("message")}
      minRows={1}
      value={text}
      disabled={!canSend}
      placeholder={!open ? t("over") : approval ? t("approvalPlaceholder") : t("message")}
      onChange={(e) => {
        e.preventDefault(); // This controlled draft stays here until delivery succeeds.
        setText(e.target.value);
      }}
      onKeyDown={(e) => {
        // The Approve shortcut, on an empty draft only: what was typed is never sent as a yes.
        if (approval && e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && !text.trim()) {
          e.preventDefault();
          void approve();
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void send();
        }
      }}
      className={`${composerTools ? "w-full basis-full" : "flex-1"} min-h-9 min-w-0 resize-none bg-transparent px-2 py-[7px] text-[15px] leading-5 outline-none placeholder:text-faint disabled:opacity-60`}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatThread
        run={run}
        chatStepId={chatStep?.id}
        canSend={canSend}
        onSend={sendText}
        onAttach={hold}
        welcome={welcome}
        centeredWelcome={!!composerTools}
        composer={
          <div className={`shrink-0 px-4 pb-4 pt-2 ${composerTools ? "" : "bg-surface"}`}>
            {error && (
              <p role="alert" className="mb-2 px-1 text-[13px] text-danger">
                {error}
              </p>
            )}
            {asking && <p className="mb-2 px-1 text-[13px] text-muted">{t("answerAbove")}</p>}
            {approval && open && (
              <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-1">
                <Button type="button" size="sm" disabled={sending} onClick={() => void approve()} className="rounded-full">
                  <ShieldCheck aria-hidden />
                  {t("approve")}
                </Button>
                <span className="text-[13px] text-muted">{t("approveHint")}</span>
              </div>
            )}
            <form
              className={`mx-auto flex w-full max-w-3xl flex-wrap items-end gap-2 rounded-2xl border border-line p-3 focus-within:border-accent ${composerTools ? "bg-surface/85 shadow-sm backdrop-blur-xl" : "bg-surface"}`}
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {runId && !composerTools && onNewConversation && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("newConversation")}
                  title={t("newConversation")}
                  className="rounded-full text-muted"
                  // Not while a message is on its way: its completion clears the draft of this conversation.
                  disabled={sending}
                  onClick={() => {
                    setText("");
                    setError(null);
                    draft.current++;
                    if (files.current) void files.current.remove(files.current.ids());
                    onNewConversation();
                  }}
                >
                  <MessageSquarePlus aria-hidden />
                </Button>
              )}
              <ComposerAttachments handle={files} hidden={!!approval} disabled={!canSend || sending} />
              {assistantAgentId ? <AssistantInput agentId={assistantAgentId} runId={runId} onTextChange={setText} onSkillChange={setChosenSkill} inputProps={composerInput.props} /> : composerInput}
              {composerTools && <div className="min-w-0 flex-1">{composerTools}</div>}
              <Button type="submit" size="icon-sm" aria-label={t("send")} disabled={!canSend || sending || holding > 0 || !text.trim()} className="rounded-full">
                <ArrowUp aria-hidden />
              </Button>
            </form>
            <p className="mx-auto mt-2 hidden max-w-3xl px-1 text-[11px] text-faint md:block">
              {approval ? t("hintApproval", { mod: MOD }) : t("hintSend")}
            </p>
          </div>
        }
      >
        <AfterChat run={run} chatStepId={chatStep?.id} def={runDef} />
      </ChatThread>
    </div>
  );
}

/** The key the Approve shortcut names: ⌘ on Apple systems, Ctrl elsewhere (both work everywhere). */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** Under the messages: why the conversation stopped, or the steps that follow it. */
function AfterChat({ run, chatStepId, def }: { run: RunSnapshot | null; chatStepId: string | undefined; def: WorkflowDef | undefined }) {
  const { t } = useTranslation("chat");
  const stored = useStored();
  const chatStep = run?.steps.find((s) => s.id === chatStepId);
  const followUps = run?.steps.filter((s) => s.id !== chatStepId) ?? [];
  return (
    <>
      {chatStep?.status === "failed" && (
        <p role="alert" className="mt-3 px-1 text-[13px] text-danger">
          {(chatStep.error ?? run?.run.error) ? t("stopped", { error: stored(chatStep.error ?? run?.run.error) }) : t("stoppedAgent")}
        </p>
      )}
      {chatStep?.status === "succeeded" && run && <Progress run={run} steps={followUps} def={def} />}
    </>
  );
}

/** After the confirmation: the steps that follow, with their results. */
function Progress({ run, steps, def }: { run: RunSnapshot; steps: Step[]; def: WorkflowDef | undefined }) {
  const { t } = useTranslation("chat");
  const stored = useStored();
  const names = new Map(def ? nodesOf(def).map((n) => [n.id, n.name]) : []);
  return (
    <section aria-label={t("progress")} className="mt-4 flex flex-col gap-2 rounded-2xl bg-hover p-3">
      {steps.map((s) => (
        <div key={s.id} className="rounded-xl bg-surface px-3 py-2.5">
          <div className="flex items-center gap-2">
            <StepIcon status={s.status} />
            <p className="flex-1 text-[14px] font-medium">{names.get(s.nodeId) ?? t("step")}</p>
            <span className="text-[12px] text-muted">{t(`stepStatus.${s.status}`)}</span>
          </div>
          {s.status === "succeeded" && s.outputs && <Outputs outputs={s.outputs} />}
          {s.error && <p className="mt-1 text-[13px] text-danger">{stored(s.error)}</p>}
        </div>
      ))}
      <p className="px-1 pt-1 text-[13px] text-muted" role="status">
        {run.run.status === "succeeded" ? t("allDone") : run.run.status === "failed" ? (run.run.error ? t("runStopped", { error: stored(run.run.error) }) : t("runStoppedStep")) : t("runRunning")}
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
