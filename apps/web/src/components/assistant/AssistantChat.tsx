import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2, PanelLeft, MoreHorizontal, MessageSquarePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import { localTimezone } from "../agents/TriggerSheet.tsx";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { HarnessSheet } from "../settings/HarnessSheet.tsx";
import { Empty } from "../settings/parts.tsx";
import { useChatSelection, useChatSessions } from "../../lib/chat-sessions.tsx";
import { useFormat } from "../../lib/format.ts";
import { ChatPanel } from "../widgets/ChatPanel.tsx";
import { ReviewSwitch } from "./ReviewSwitch.tsx";
import { AssistantSettings } from "./AssistantSettings.tsx";

/** The URL's `run` for a conversation that hasn't started: no run id looks like it. */
export const NEW_CONVERSATION = "new";

type Props = {
  /** The conversation the URL names: absent, the latest; `NEW_CONVERSATION`, a new one. */
  run: string | undefined;
  /** Opens a conversation (absent: the latest), by putting it in the URL. */
  onOpen: (run: string | undefined, options?: { replace?: boolean }) => void;
};

/** The workspace's Assistant: its chat and its conversations, or, until there is one, the harness it will run on. */
export function AssistantChat({ run, onOpen }: Props) {
  const { t } = useTranslation(["assistant", "messages", "common"]);
  const assistantName = t("messages:agent.assistant.name");
  const assistant = useQuery(orpc.agents.assistant.queryOptions());
  if (assistant.error) return <p role="alert" className="text-[14px] text-danger">{t("loadFailed", { assistant: assistantName })}</p>;
  if (assistant.data === undefined) return <p className="text-[14px] text-faint">{t("common:loading")}</p>;
  if (assistant.data === null) return <div className="min-h-0 overflow-y-auto"><PickHarness /></div>;
  return <Conversation key={assistant.data.triggerId} triggerId={assistant.data.triggerId} agentId={assistant.data.agentId} reviewTriggerId={assistant.data.reviewTriggerId} run={run} onOpen={onOpen} />;
}

function Conversation({ triggerId, agentId, reviewTriggerId, run, onOpen }: { triggerId: string; agentId: string; reviewTriggerId?: string | null } & Props) {
  const { t } = useTranslation(["assistant", "messages", "common"]);
  const format = useFormat();
  const assistantName = t("messages:agent.assistant.name");
  const jobs = useQuery(orpc.runs.list.queryOptions({ input: { triggerId, kind: "chat" } }));
  const surfaceKey = `assistant:${triggerId}`;
  const [chosen, setChosen] = useChatSelection(surfaceKey);
  const sessions = useChatSessions();
  const selected = run === undefined ? chosen : run === NEW_CONVERSATION ? null : run;
  const runId = selected === undefined ? (jobs.data?.[0]?.id ?? null) : selected;
  useEffect(() => {
    if (jobs.data) setChosen(runId);
  }, [jobs.data, runId, setChosen]);
  const [history, setHistory] = useState(false);
  const [settings, setSettings] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setExpanded(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  if (jobs.error && !jobs.data) return <p role="alert">{t("conversationsFailed", { assistant: assistantName })}</p>;
  if (!jobs.data) return <p>{t("common:loading")}</p>;
  const title = jobs.data.find((job) => job.id === runId)?.title ?? t("newChat");
  const open = (id: string) => { if (id === NEW_CONVERSATION) sessions.newConversation(surfaceKey); onOpen(id); setHistory(false); };
  return (
    <div className={expanded ? "fixed inset-0 z-40 flex h-dvh flex-col bg-surface" : "flex min-h-0 flex-1 flex-col bg-surface"}>
      <header className={`relative flex min-h-16 shrink-0 items-center gap-1 px-3 sm:gap-2 ${expanded ? "spectrum-header" : "border-b border-line"}`}>
        <Button variant="ghost" size="icon" aria-label={t("history")} onClick={() => setHistory(true)}><PanelLeft aria-hidden /></Button>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <h1 className="truncate text-sm font-semibold min-[521px]:text-base" title={title}>{title}</h1>
          <span className="inline-flex items-center gap-2 text-[13px] text-muted">
            <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-accent" />
            {assistantName}
          </span>
        </div>
        <Button variant="ghost" size="icon" aria-label={t("newConversation")} onClick={() => open(NEW_CONVERSATION)}><MessageSquarePlus aria-hidden /></Button>
        <Button variant="ghost" size="icon" aria-label={t("options", { assistant: assistantName })} onClick={() => setSettings(true)}><MoreHorizontal aria-hidden /></Button>
        <Button variant="ghost" size="icon" aria-label={expanded ? t("exitFullPage") : t("fullPage")} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}</Button>
      </header>
      {history && <Sheet open onOpenChange={setHistory}><SheetContent side="left" className="bg-surface"><SheetHeader><SheetTitle>{t("conversations")}</SheetTitle><SheetDescription>{t("conversationsText", { assistant: assistantName })}</SheetDescription></SheetHeader>
        <nav aria-label={t("conversations")} className="min-h-0 flex-1 overflow-y-auto p-3">
          <Button variant="ghost" onClick={() => open(NEW_CONVERSATION)}><MessageSquarePlus aria-hidden />{t("newConversation")}</Button>
          <ul className="space-y-1">{jobs.data.map((job) => <li key={job.id}><button type="button" aria-current={job.id === runId ? "true" : undefined} onClick={() => open(job.id)} className="w-full rounded-lg px-3 py-2 text-left hover:bg-hover"><span className="block truncate text-sm">{job.title ?? t("noMessage")}</span><span className="text-xs text-muted">{format.dateTimeSeconds(job.createdAt)}</span></button></li>)}</ul>
        </nav>
      </SheetContent></Sheet>}
      {settings && <Sheet open onOpenChange={setSettings}><SheetContent className="bg-surface"><SheetHeader><SheetTitle>{t("options", { assistant: assistantName })}</SheetTitle><SheetDescription>{t("optionsText", { assistant: assistantName })}</SheetDescription></SheetHeader><div className="p-4">{reviewTriggerId && <ReviewSwitch triggerId={reviewTriggerId} />}</div></SheetContent></Sheet>}
      <section aria-label={t("chat", { assistant: assistantName })} className="flex min-h-0 flex-1 flex-col">
        <ChatPanel surfaceKey={surfaceKey} assistantAgentId={agentId} start={(skillId) => api.jobs.start({ triggerId, timezone: localTimezone(), ...(skillId ? { skillId } : {}) })} runId={runId} onRunStarted={(id) => onOpen(id, { replace: true })} onNewConversation={() => onOpen(NEW_CONVERSATION)} welcome={t("welcome")} composerTools={<AssistantSettings agentId={agentId} />} />
      </section>
    </div>
  );
}

/**
 * First launch, before there is an Assistant: the harness it will run on. Without one yet, the
 * owner adds it here (the harness sheet: a cloud provider and key, or a paired runner's CLI);
 * the Assistant is made only when the owner then starts it on the harness picked.
 */
function PickHarness() {
  const { t } = useTranslation(["assistant", "messages", "common"]);
  const assistantName = t("messages:agent.assistant.name");
  const queryClient = useQueryClient();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const [adding, setAdding] = useState(false);
  const runners = useQuery({ ...orpc.runners.list.queryOptions({ refetchInterval: 5000 }), enabled: adding });
  const [harnessId, setHarnessId] = useState("");
  // It adds an agent, its chat and the platform skill: everything shown may have changed.
  const ensure = useMutation(orpc.agents.ensureAssistant.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }));
  if (harnesses.error && !harnesses.data) return <p role="alert" className="text-[14px] text-danger">{t("harnessesFailed")}</p>;
  if (!harnesses.data) return <p className="text-[14px] text-faint">{t("common:loading")}</p>;
  const none = harnesses.data.length === 0;
  return (
    <>
      {none ? (
        <Empty title={t("chooseTitle", { assistant: assistantName })} text={t("chooseText")}>
          <Button onClick={() => setAdding(true)}>{t("addHarness")}</Button>
        </Empty>
      ) : (
        <form
          className="space-y-4 rounded-2xl bg-surface p-6 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (harnessId) ensure.mutate({ harnessId });
          }}
        >
          <p className="text-[14px] text-muted">{t("pickText", { assistant: assistantName })}</p>
          <div className="flex flex-wrap items-center gap-3">
            <select aria-label={t("harness")} value={harnessId} onChange={(e) => setHarnessId(e.target.value)} className={selectClass}>
              <option value="">{t("pickHarness")}</option>
              {harnesses.data.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="ghost" onClick={() => setAdding(true)}>
              {t("addHarness")}
            </Button>
          </div>
          {ensure.error && (
            <p role="alert" className="text-[13px] text-danger">
              {t("startFailed", { assistant: assistantName })}
            </p>
          )}
          <Button type="submit" disabled={!harnessId || ensure.isPending}>
            {t("start", { assistant: assistantName })}
          </Button>
        </form>
      )}
      {adding && (
        <HarnessSheet
          runners={runners.data ?? []}
          onClose={() => setAdding(false)}
          onSaved={(saved, created) => {
            setAdding(false);
            if (created) setHarnessId(saved.id);
          }}
        />
      )}
    </>
  );
}
