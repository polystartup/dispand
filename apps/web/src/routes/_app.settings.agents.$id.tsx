import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentEditor } from "../components/settings/AgentEditor.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/agents/$id")({ component: EditAgent });

function EditAgent() {
  const { id } = Route.useParams();
  const agent = useQuery(orpc.agents.get.queryOptions({ input: { id } }));
  return (
    <>
      <PageHeader title={agent.data?.name ?? "Agent"} subtitle="Change what this agent does and where it runs." />
      {agent.error && <p role="alert" className="text-[14px] text-danger">Could not load the agent.</p>}
      {/* Keyed: moving between two agents (history) must not keep the previous one's draft. */}
      {agent.data && <AgentEditor key={agent.data.id} agent={agent.data} />}
    </>
  );
}
