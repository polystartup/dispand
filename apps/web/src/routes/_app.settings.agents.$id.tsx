import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { JobList } from "../components/agents/JobList.tsx";
import { TriggerList } from "../components/agents/TriggerList.tsx";
import { AgentEditor } from "../components/settings/AgentEditor.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/agents/$id")({ component: EditAgent });

const TABS = [
  ["settings", "Settings"],
  ["triggers", "Triggers"],
  ["jobs", "Jobs"],
] as const;
const tab = "-mb-px border-b-2 px-1 pb-2.5 text-[14px] transition";

function EditAgent() {
  const { id } = Route.useParams();
  const agent = useQuery(orpc.agents.get.queryOptions({ input: { id } }));
  const [shown, setShown] = useState<(typeof TABS)[number][0]>("settings");
  return (
    <>
      <PageHeader title={agent.data?.name ?? "Agent"} subtitle="What this agent does, what makes it work, and the Jobs it did." />
      {agent.error && <p role="alert" className="text-[14px] text-danger">Could not load the agent.</p>}
      {agent.data && (
        <>
          <div role="tablist" aria-label="Agent" className="mb-6 flex gap-5 border-b border-line">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={shown === key}
                onClick={() => setShown(key)}
                className={shown === key ? `${tab} border-accent font-medium text-fg` : `${tab} border-transparent text-muted hover:text-fg`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Kept mounted: switching tabs must not drop an unsaved draft. Keyed: moving between two agents (history) must not keep the previous one's. */}
          <div hidden={shown !== "settings"}>
            <AgentEditor key={agent.data.id} agent={agent.data} />
          </div>
          {shown === "triggers" && <TriggerList agentId={agent.data.id} />}
          {shown === "jobs" && <JobList agentId={agent.data.id} />}
        </>
      )}
    </>
  );
}
