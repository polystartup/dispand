import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { JobList } from "../components/agents/JobList.tsx";
import { TriggerList } from "../components/agents/TriggerList.tsx";
import { MemoryPanel } from "../components/memory/MemoryPanel.tsx";
import { AgentEditor } from "../components/settings/AgentEditor.tsx";
import { StateTabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/agents/$id")({ component: EditAgent });

const TABS = [
  ["settings", "Settings"],
  ["triggers", "Triggers"],
  ["jobs", "Jobs"],
  ["memory", "Memory"],
] as const;

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
          <StateTabs label="Agent" tabs={TABS} selected={shown} onSelect={setShown}>
            {/* Kept mounted: switching tabs must not drop an unsaved draft. Keyed: moving between two agents (history) must not keep the previous one's. */}
            <TabsPrimitive.Content value="settings" forceMount className="data-[state=inactive]:hidden">
              <AgentEditor key={agent.data.id} agent={agent.data} />
            </TabsPrimitive.Content>
            <TabsPrimitive.Content value="triggers">
              <TriggerList agentId={agent.data.id} />
            </TabsPrimitive.Content>
            <TabsPrimitive.Content value="jobs">
              <JobList agentId={agent.data.id} />
            </TabsPrimitive.Content>
            <TabsPrimitive.Content value="memory">
              <MemoryPanel key={agent.data.id} where={{ scope: "agent", agentId: agent.data.id }} />
            </TabsPrimitive.Content>
          </StateTabs>
        </>
      )}
    </>
  );
}
