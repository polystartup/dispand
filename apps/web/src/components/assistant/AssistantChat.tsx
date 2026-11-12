import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { Empty } from "../settings/parts.tsx";
import { ChatPanel } from "../widgets/ChatPanel.tsx";

/** The workspace's Assistant: its chat, or, until there is one, the harness it will run on. */
export function AssistantChat() {
  const assistant = useQuery(orpc.agents.assistant.queryOptions());
  if (assistant.error) return <p role="alert" className="text-[14px] text-danger">Could not load the Assistant.</p>;
  if (assistant.data === undefined) return <p className="text-[14px] text-faint">Loading…</p>;
  if (assistant.data === null) return <PickHarness />;
  return <Conversation key={assistant.data.triggerId} triggerId={assistant.data.triggerId} />;
}

/** The Assistant's chat trigger: its latest conversation, or a new one started by the first message. */
function Conversation({ triggerId }: { triggerId: string }) {
  const jobs = useQuery(orpc.runs.list.queryOptions({ input: { triggerId } }));
  // undefined: follow the latest conversation; null: a new one that hasn't started yet.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const runId = chosen === undefined ? (jobs.data?.[0]?.id ?? null) : chosen;
  if (jobs.error && !jobs.data) return <p role="alert" className="text-[14px] text-danger">Could not load the Assistant's conversations.</p>;
  if (!jobs.data) return <p className="text-[14px] text-faint">Loading…</p>;
  return (
    <section aria-label="Assistant" className="flex h-[calc(100dvh-16rem)] min-h-96 flex-col overflow-hidden rounded-2xl bg-surface shadow-card">
      <ChatPanel start={() => api.jobs.start({ triggerId })} runId={runId} onRunStarted={setChosen} onNewConversation={() => setChosen(null)} />
    </section>
  );
}

/** No Assistant yet: the owner picks the harness it runs on, which makes it. */
function PickHarness() {
  const queryClient = useQueryClient();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const [harnessId, setHarnessId] = useState("");
  const ensure = useMutation(orpc.agents.ensureAssistant.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.agents.key() }) }));
  if (harnesses.error && !harnesses.data) return <p role="alert" className="text-[14px] text-danger">Could not load the harnesses.</p>;
  if (!harnesses.data) return <p className="text-[14px] text-faint">Loading…</p>;
  if (harnesses.data.length === 0) {
    return (
      <Empty title="Add a harness first" text="The Assistant runs on a harness: connect a cloud model or a runner's CLI, then come back.">
        <Button asChild>
          <Link to="/settings/harnesses">Go to harnesses</Link>
        </Button>
      </Empty>
    );
  }
  return (
    <form
      className="space-y-4 rounded-2xl bg-surface p-6 shadow-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (harnessId) ensure.mutate({ harnessId });
      }}
    >
      <p className="text-[14px] text-muted">Pick the harness the Assistant runs on. You can change it later on its agent page.</p>
      <select aria-label="Harness" value={harnessId} onChange={(e) => setHarnessId(e.target.value)} className={selectClass}>
        <option value="">Pick a harness</option>
        {harnesses.data.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
      {ensure.error && (
        <p role="alert" className="text-[13px] text-danger">
          Could not start the Assistant. Try again.
        </p>
      )}
      <Button type="submit" disabled={!harnessId || ensure.isPending}>
        Start the Assistant
      </Button>
    </form>
  );
}
