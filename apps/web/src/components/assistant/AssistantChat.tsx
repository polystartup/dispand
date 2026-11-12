import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import { localTimezone } from "../agents/TriggerSheet.tsx";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { HarnessSheet } from "../settings/HarnessSheet.tsx";
import { Empty } from "../settings/parts.tsx";
import { when } from "../workflow/Runs.tsx";
import { ChatPanel } from "../widgets/ChatPanel.tsx";
import { ReviewSwitch } from "./ReviewSwitch.tsx";

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
  if (assistant.data === null) return <PickHarness />;
  return (
    <>
      {assistant.data.reviewTriggerId && <ReviewSwitch triggerId={assistant.data.reviewTriggerId} />}
      <Conversation key={assistant.data.triggerId} triggerId={assistant.data.triggerId} run={run} onOpen={onOpen} />
    </>
  );
}

/** The Assistant's chat trigger: its conversations, newest first, and the one the URL opens. */
function Conversation({ triggerId, run, onOpen }: { triggerId: string } & Props) {
  const jobs = useQuery(orpc.runs.list.queryOptions({ input: { triggerId, kind: "chat" } }));
  if (jobs.error && !jobs.data) return <p role="alert" className="text-[14px] text-danger">Could not load the Assistant's conversations.</p>;
  if (!jobs.data) return <p className="text-[14px] text-faint">Loading…</p>;
  const runId = run === NEW_CONVERSATION ? null : (run ?? jobs.data[0]?.id ?? null);
  return (
    <div className="flex h-[calc(100dvh-19rem)] min-h-96 flex-col gap-4 md:flex-row">
      <nav aria-label="Conversations" className="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto rounded-2xl bg-surface p-2 shadow-card md:max-h-none md:w-64">
        <Button type="button" variant="ghost" className="justify-start gap-2" onClick={() => onOpen(NEW_CONVERSATION)}>
          <MessageSquarePlus aria-hidden />
          New conversation
        </Button>
        <ul className="flex flex-col gap-0.5">
          {jobs.data.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                aria-current={job.id === runId ? "true" : undefined}
                onClick={() => onOpen(job.id)}
                className={`flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition hover:bg-hover ${job.id === runId ? "bg-hover" : ""}`}
              >
                <span className="w-full truncate text-[14px] font-medium">{job.title ?? "No message yet"}</span>
                <span className="text-[12px] text-muted">{when.format(job.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section aria-label="Assistant" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-surface shadow-card">
        <ChatPanel
          start={() => api.jobs.start({ triggerId, timezone: localTimezone() })}
          runId={runId}
          onRunStarted={(id) => onOpen(id, { replace: true })}
          onNewConversation={() => onOpen(NEW_CONVERSATION)}
          welcome={WELCOME}
        />
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
          <p className="text-[14px] text-muted">Pick the harness the Assistant runs on. You can change it later on its agent page.</p>
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
