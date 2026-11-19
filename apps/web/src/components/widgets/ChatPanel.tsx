import { ChatComposer } from "../chat/Composer.tsx";
import { QueuedMessages } from "../chat/QueuedMessages.tsx";
import { MessageNotSentError, type AppendMessage, type QuoteInfo } from "@assistant-ui/react";
import { heldAttachments, type QueueActions, textOf, useRunThread } from "../../lib/assistant-runtime.ts";
import { nodesOf, type WorkflowDef } from "@dispand/domain/workflows/model";
import { SHORT } from "@dispand/runner-protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";
import { api, orpc } from "../../lib/api.ts";
import { canReopen, type RunSnapshot } from "../../lib/run-state.ts";
import { refreshRun, useRun } from "../../lib/run-watch.ts";
import { ChatThread, composerApproval } from "../chat/Thread.tsx";
import { useStored } from "@/lib/message";
import { ChatSession, useChatSessions } from "../../lib/chat-sessions.tsx";

type Step = RunSnapshot["steps"][number];

export type ChatPanelOptions = {
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

export type ChatSessionView = ReactNode;

/** Visible surfaces attach to session-owned runtimes without copying composer state. */
export function ChatPanel({ surfaceKey, ...options }: ChatPanelOptions & { surfaceKey: string }) {
  const sessions = useChatSessions();
  const generation = useSyncExternalStore(sessions.subscribe, () => sessions.generation(surfaceKey), () => 0);
  const [session, setSession] = useState<ChatSession | null>(null);
  const { workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId } = options;
  useLayoutEffect(() => {
    const next = sessions.get(surfaceKey, { workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId });
    next.setActive(true);
    next.update({ workflowId, start, runId: runId ?? next.options.runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId });
    setSession(next);
    return () => { sessions.deactivate(next); };
  }, [sessions, surfaceKey, generation, workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId]);
  return session ? <SessionView key={session.id} session={session} /> : null;
}

function SessionView({ session }: { session: ChatSession }) {
  return useSyncExternalStore(session.subscribe, session.getView, session.getView);
}

/** Mounted until sign-out: background operations remain attached to their original composer. */
export function ChatSessionHost({ session }: { session: ChatSession }) {
  const sessions = useChatSessions();
  const { workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId } = useSyncExternalStore(session.subscribe, session.getOptions, session.getOptions);
  const active = useSyncExternalStore(session.subscribe, session.getActive, session.getActive);
  const run = useRun(active ? runId : null);
  const version = run?.run.version;
  const versionDef = useQuery({
    ...orpc.workflows.get.queryOptions({ input: { id: workflowId ?? "", version: version ?? 0 } }),
    enabled: !!workflowId && version !== undefined,
    staleTime: Infinity,
  }).data?.def;
  const jobDef = useQuery({
    ...orpc.jobs.def.queryOptions({ input: { runId: runId ?? "" } }),
    enabled: active && !workflowId && !!runId,
    staleTime: Infinity,
  }).data;
  const runDef = workflowId ? versionDef : jobDef;
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopPending = useRef(false);
  const [holding, setHolding] = useState(0);
  const { t } = useTranslation("chat");
  const { number } = useFormat();
  const hold = useCallback(async (file: File) => {
    sessions.begin(session);
    setHolding((n) => n + 1);
    try {
      const held = await api.files.hold({ file });
      return held;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("attachFailed"));
      throw err;
    } finally {
      setHolding((n) => n - 1);
      sessions.settle(session);
    }
  }, [t, sessions, session]);
  const chatField = runDef?.trigger.field.type === "chat" ? runDef.trigger.field.id : undefined;
  const chatStep = run?.steps.find((s) => s.interactive) ?? run?.steps.find((s) => s.nodeId === chatField && s.status === "pending");
  const open = !runId || !run || canReopen(run) || (!!chatStep && ["running", "waiting", "pending"].includes(chatStep.status));
  const approval = composerApproval(run?.questions ?? [], chatStep?.id);
  const asking = !approval && !!run?.questions.some((q) => q.stepRunId === chatStep?.id && q.status === "pending");
  const canSend = active && (!runId || !!run) && open && !asking;
  const canStop = active && open && chatStep?.turnStatus === "running" && ["running", "waiting"].includes(chatStep.status) && chatStep.interruptible && !!chatStep.turnId;

  async function stop() {
    if (!canStop || !runId || !chatStep?.turnId || sending || stopPending.current) return;
    stopPending.current = true;
    sessions.begin(session);
    setStopping(true);
    setError(null);
    try {
      const result = await api.runs.interruptChat({ runId, turnId: chatStep.turnId });
      if (result.outcome === "failed") setError(t("stopFailed"));
      else if (result.outcome === "stale") await refreshRun(runId);
    } catch {
      setError(t("stopFailed"));
    } finally {
      stopPending.current = false;
      setStopping(false);
      sessions.settle(session);
    }
  }

  async function answerApproval(answer: { decision: "allow" } | { decision: "deny"; message: string }): Promise<boolean> {
    if (!approval || sending || stopPending.current) return false;
    sessions.begin(session);
    setSending(true);
    setError(null);
    try {
      if (answer.decision === "deny" && answer.message.length > SHORT) throw new Error(t("tooLong", { max: number(SHORT) }));
      await api.questions.answer({ questionId: approval.id, answer: { kind: "permission", ...answer } });
      return true;
    } catch (err) {
      setError((err as { code?: string }).code === "CONFLICT" ? t("conflictProposal") : err instanceof Error ? err.message : t("approveFailed"));
      return false;
    } finally {
      void queryClient.invalidateQueries({ queryKey: orpc.questions.key() });
      setSending(false);
      sessions.settle(session);
    }
  }

  async function send(message: AppendMessage) {
    const text = textOf(message).trim();
    if (!text || sending || stopPending.current || !canSend || approval) throw new MessageNotSentError(t("sendFailed"));
    sessions.begin(session);
    const chosenSkill = message.runConfig?.custom?.skill as { name: string; skillId?: string } | undefined;
    const skillId = chosenSkill && text.split(/\s/, 1)[0] === `/${chosenSkill.name}` ? chosenSkill.skillId : undefined;
    setSending(true);
    setError(null);
    try {
      let id = runId;
      if (!id) {
        id = (await (start ? start(skillId) : api.runs.start({ workflowId: workflowId ?? "" }))).runId;
        if (!sessions.alive) throw new MessageNotSentError(t("sendFailed"));
        sessions.started(session, id);
        if (session.active) onRunStarted(id);
        void queryClient.invalidateQueries({ queryKey: orpc.runs.list.key() });
      }
      const attachmentIds = message.attachments?.map((file) => file.id) ?? [];
      const quote = message.metadata?.custom.quote as QuoteInfo | undefined;
      const words = quote ? `${text}\n\n${quote.text.split("\n").map((line) => `> ${line}`).join("\n")}` : text;
      await api.runs.sendChat({ runId: id, text: words, ...(skillId ? { skillId } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) });
      void queryClient.invalidateQueries({ queryKey: orpc.runs.list.key() });
    } catch (err) {
      const reason = err instanceof Error ? err.message : t("sendFailed");
      setError(reason);
      // The library returns the submitted draft, including files and quote, without losing newer typing.
      throw new MessageNotSentError(reason);
    } finally {
      setSending(false);
      sessions.settle(session);
    }
  }

  /** Keeps the owner's words: back in the composer, after what it holds. */
  function giveBack(words: string) {
    const composer = runtime.thread.composer;
    const current = composer.getState().text;
    composer.setText(current.trim() ? `${current}\n\n${words}` : words);
  }

  const conflict = (err: unknown) => (err as { code?: string }).code === "CONFLICT";
  const queue: QueueActions | undefined = runId ? {
    // Sent while a turn runs: the server queues it. The library cleared the draft already, so a failure gives the words back.
    send: (message) => void send(message).catch(() => giveBack(textOf(message))),
    // Refused when the turn ended or the message went first: it stays queued, or is sent already.
    steer: (queuedId) => void api.runs.steerQueued({ runId, queuedId }).catch((err: unknown) => setError(conflict(err) ? t("steerLate") : t("steerFailed"))),
    edit: (queuedId, text) => void editQueued(queuedId, text),
    remove: (queuedId) => void api.runs.removeQueued({ runId, queuedId }).catch((err: unknown) => setError(conflict(err) ? t("queuedGone") : t("queuedRemoveFailed"))),
  } : undefined;

  async function editQueued(queuedId: string, text: string): Promise<boolean> {
    if (!runId) return false;
    setError(null);
    try {
      await api.runs.editQueued({ runId, queuedId, text });
      return true;
    } catch (err) {
      // Sent before the edit landed: the edit isn't lost, it waits in the composer.
      if (conflict(err)) {
        giveBack(text);
        setError(t("queuedSentBeforeEdit"));
      } else setError(t("queuedEditFailed"));
      return false;
    }
  }

  const attachments = useMemo(() => heldAttachments(hold), [hold]);
  const runtime = useRunThread({ run, chatStepId: chatStep?.id, canSend: canSend && !sending && !stopping && holding === 0, onSend: send, onCancel: canStop ? stop : undefined, attachments, queue,
    suggestions: assistantAgentId && !approval ? [
      { title: t("starterAgent"), prompt: t("starterAgentPrompt") },
      { title: t("starterReview"), prompt: t("starterReviewPrompt") },
    ] : [],
  });
  const view = <div className="flex min-h-0 flex-1 flex-col">
    <ChatThread runtime={runtime} run={run} chatStepId={chatStep?.id} canSend={canSend && !sending && holding === 0} onSend={send} onAttach={hold}
      welcome={welcome} starterPrompts={!!assistantAgentId && !approval} centeredWelcome={!!composerTools}
      composer={<ChatComposer runId={runId} assistantAgentId={assistantAgentId} tools={composerTools} open={open} asking={asking} approval={!!approval}
        busy={sending || stopping} error={error} queued={<QueuedMessages queued={new Map((run?.queue ?? []).map((q) => [q.id, q]))} onEdit={editQueued} steering={chatStep?.turnStatus === "running" && chatStep.turnId ? chatStep.steering : null} />} onNewConversation={onNewConversation ? () => { sessions.newConversation(session.surfaceKey); onNewConversation(); } : undefined}
        onApprove={() => answerApproval({ decision: "allow" })} onDecline={(message) => answerApproval({ decision: "deny", message })} />}
    >
      <AfterChat run={run} chatStepId={chatStep?.id} def={runDef} />
    </ChatThread>
  </div>;
  useLayoutEffect(() => { session.publish(view); });
  return null;
}

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
