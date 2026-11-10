import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { RunList, WorkflowTabs } from "../components/workflow/Runs.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/workflows/$id_/runs")({ component: WorkflowRuns });

/** One workflow's latest runs. */
function WorkflowRuns() {
  const { id } = Route.useParams();
  const workflow = useQuery(orpc.workflows.get.queryOptions({ input: { id }, staleTime: Infinity }));
  return (
    <>
      <Link to="/settings/workflows" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition hover:text-fg">
        <ChevronLeft size={15} aria-hidden /> Workflows
      </Link>
      <h1 className="mb-6 truncate text-[28px] font-semibold leading-tight tracking-tight">{workflow.data?.name ?? " "}</h1>
      <WorkflowTabs id={id} />
      <RunList workflowId={id} />
    </>
  );
}
