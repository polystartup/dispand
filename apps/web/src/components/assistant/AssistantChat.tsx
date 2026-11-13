import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2, PanelLeft, MoreHorizontal, MessageSquarePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import { localTimezone } from "../agents/TriggerSheet.tsx";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { HarnessSheet } from "../settings/HarnessSheet.tsx";
import { Empty } from "../settings/parts.tsx";
import { when } from "../workflow/Runs.tsx";
import { ChatPanel } from "../widgets/ChatPanel.tsx";
import { ReviewSwitch } from "./ReviewSwitch.tsx";
import { AssistantSettings } from "./AssistantSettings.tsx";

/** What the Assistant's empty conversation asks first: the day-one conversation's opening. */
export const WELCOME = "Describe your business or use case and how you'd like to automate it.";

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
  const assistant = useQuery(orpc.agents.assistant.queryOptions());
  if (assistant.error) return <p role="alert" className="text-[14px] text-danger">Could not load the Assistant.</p>;
  if (assistant.data === undefined) return <p className="text-[14px] text-faint">Loading…</p>;
  if (assistant.data === null) return <div className="min-h-0 overflow-y-auto"><PickHarness /></div>;
  return <Conversation key={assistant.data.triggerId} triggerId={assistant.data.triggerId} agentId={assistant.data.agentId} reviewTriggerId={assistant.data.reviewTriggerId} run={run} onOpen={onOpen} />;
}

function Conversation({ triggerId, agentId, reviewTriggerId, run, onOpen }: { triggerId: string; agentId: string; reviewTriggerId?: string | null } & Props) {
  const jobs = useQuery(orpc.runs.list.queryOptions({ input: { triggerId, kind: "chat" } }));
  const [history, setHistory] = useState(false);
  const [settings, setSettings] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setExpanded(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  if (jobs.error && !jobs.data) return <p role="alert">Could not load the Assistant's conversations.</p>;
  if (!jobs.data) return <p>Loading…</p>;
  const runId = run === NEW_CONVERSATION ? null : (run ?? jobs.data[0]?.id ?? null);
  const title = jobs.data.find((job) => job.id === runId)?.title ?? "New chat";
  const open = (id: string) => { onOpen(id); setHistory(false); };
  return (
    <div className={expanded ? "fixed inset-0 z-40 flex h-dvh flex-col bg-surface" : "flex min-h-0 flex-1 flex-col bg-surface"}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <Button variant="ghost" size="icon" aria-label="Conversation history" onClick={() => setHistory(true)}><PanelLeft aria-hidden /></Button>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">{title}</h1>
        <Button variant="ghost" size="icon" aria-label="New conversation" onClick={() => open(NEW_CONVERSATION)}><MessageSquarePlus aria-hidden /></Button>
        <Button variant="ghost" size="icon" aria-label="Assistant options" onClick={() => setSettings(true)}><MoreHorizontal aria-hidden /></Button>
        <Button variant="ghost" size="icon" aria-label={expanded ? "Exit full page" : "Full page"} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}</Button>
      </header>
      {history && <Sheet open onOpenChange={setHistory}><SheetContent side="left" className="bg-surface"><SheetHeader><SheetTitle>Conversations</SheetTitle><SheetDescription>Your Assistant chats.</SheetDescription></SheetHeader>
        <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto p-3">
          <Button variant="ghost" onClick={() => open(NEW_CONVERSATION)}><MessageSquarePlus aria-hidden />New conversation</Button>
          <ul className="space-y-1">{jobs.data.map((job) => <li key={job.id}><button type="button" aria-current={job.id === runId ? "true" : undefined} onClick={() => open(job.id)} className="w-full rounded-lg px-3 py-2 text-left hover:bg-hover"><span className="block truncate text-sm">{job.title ?? "No message yet"}</span><span className="text-xs text-muted">{when.format(job.createdAt)}</span></button></li>)}</ul>
        </nav>
      </SheetContent></Sheet>}
      {settings && <Sheet open onOpenChange={setSettings}><SheetContent className="bg-surface"><SheetHeader><SheetTitle>Assistant options</SheetTitle><SheetDescription>Settings for the workspace Assistant.</SheetDescription></SheetHeader><div className="p-4">{reviewTriggerId && <ReviewSwitch triggerId={reviewTriggerId} />}</div></SheetContent></Sheet>}
      <section aria-label="Assistant" className="flex min-h-0 flex-1 flex-col">
        <ChatPanel assistantAgentId={agentId} start={(skillId) => api.jobs.start({ triggerId, timezone: localTimezone(), ...(skillId ? { skillId } : {}) })} runId={runId} onRunStarted={(id) => onOpen(id, { replace: true })} onNewConversation={() => onOpen(NEW_CONVERSATION)} welcome={WELCOME} composerTools={<AssistantSettings agentId={agentId} />} />
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
  const queryClient = useQueryClient();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const [adding, setAdding] = useState(false);
  const runners = useQuery({ ...orpc.runners.list.queryOptions({ refetchInterval: 5000 }), enabled: adding });
  const [harnessId, setHarnessId] = useState("");
  // It adds an agent, its chat and the platform skill: everything shown may have changed.
  const ensure = useMutation(orpc.agents.ensureAssistant.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }));
  if (harnesses.error && !harnesses.data) return <p role="alert" className="text-[14px] text-danger">Could not load the harnesses.</p>;
  if (!harnesses.data) return <p className="text-[14px] text-faint">Loading…</p>;
  const none = harnesses.data.length === 0;
  return (
    <>
      {none ? (
        <Empty title="Choose where the Assistant runs" text="It runs on a harness: a cloud provider's API with your key, or Claude Code or Codex on one of your machines, through a runner.">
          <Button onClick={() => setAdding(true)}>Add a harness</Button>
        </Empty>
      ) : (
        <form
          className="space-y-4 rounded-2xl bg-surface p-6 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (harnessId) ensure.mutate({ harnessId });
          }}
        >
          <p className="text-[14px] text-muted">Pick the harness the Assistant runs on. You can change its harness and model later in Assistant settings.</p>
          <div className="flex flex-wrap items-center gap-3">
            <select aria-label="Harness" value={harnessId} onChange={(e) => setHarnessId(e.target.value)} className={selectClass}>
              <option value="">Pick a harness</option>
              {harnesses.data.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="ghost" onClick={() => setAdding(true)}>
              Add a harness
            </Button>
          </div>
          {ensure.error && (
            <p role="alert" className="text-[13px] text-danger">
              Could not start the Assistant. Try again.
            </p>
          )}
          <Button type="submit" disabled={!harnessId || ensure.isPending}>
            Start the Assistant
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
