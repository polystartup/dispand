import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { AgentSaved } from "../components/settings/AgentEditor.tsx";
import { Empty, List } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";
import { qualifiedName } from "@dispand/domain/plugins/names";

export const Route = createFileRoute("/_app/settings/agents/")({
  // `saved`: an agent was just created, so the list offers the next step.
  validateSearch: z.object({ saved: z.boolean().optional() }),
  component: Agents,
});

function Agents() {
  const { saved } = Route.useSearch();
  const agents = useQuery(orpc.agents.list.queryOptions());
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const loaded = agents.data && harnesses.data;
  const harnessName = new Map(harnesses.data?.map((h) => [h.id, h.name]));

  const create = (
    <Button asChild>
      <Link to="/settings/agents/new">
        <Plus /> New agent
      </Link>
    </Button>
  );

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Agents" subtitle="Define what each agent does and which harness runs it." />
        {loaded && agents.data!.length > 0 && create}
      </div>
      {saved && <AgentSaved />}
      {(agents.error || harnesses.error) && !loaded && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the {agents.error ? "agents" : "harnesses"}.
        </p>
      )}
      {loaded && agents.data!.length === 0 && (
        <Empty title="No agent yet" text="An agent is a system prompt on a harness. Workflows put agents to work.">
          {harnesses.data!.length === 0 ? (
            <Button asChild>
              <Link to="/settings/harnesses">Add a harness first</Link>
            </Button>
          ) : (
            create
          )}
        </Empty>
      )}
      {loaded && agents.data!.length > 0 && (
        <List>
          {agents.data!.map((a) => (
            <li key={a.id}>
              <Link
                to="/settings/agents/$id"
                params={{ id: a.id }}
                className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-hover"
              >
                <span className="truncate text-[15px] font-medium">{qualifiedName(a.plugin?.name ?? null, a.name)}</span>
                <span className="truncate text-[13px] text-muted">{harnessName.get(a.harnessId)}</span>
              </Link>
            </li>
          ))}
        </List>
      )}
    </>
  );
}
