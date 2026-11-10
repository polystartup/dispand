import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { RunSteps } from "../components/runs/RunSteps.tsx";
import { duration, Status, when } from "../components/workflow/Runs.tsx";
import { orpc } from "../lib/api.ts";
import { useRun } from "../lib/run-watch.ts";

export const Route = createFileRoute("/_app/settings/workflows/runs/$runId")({ component: RunPage });

/** One run as it goes: each step's prompt, outputs, error, transcript and questions, to debug it. */
function RunPage() {
  const { runId } = Route.useParams();
  // The live state comes from the stream; this read only tells a missing run from a loading one.
  const check = useQuery({ ...orpc.runs.get.queryOptions({ input: { runId } }), retry: false });
  const live = useRun(runId);
  const state = live ?? check.data ?? null;
  const run = state?.run;
  const workflow = useQuery({
    ...orpc.workflows.get.queryOptions({ input: { id: run?.workflowId ?? "", version: run?.version ?? 0 } }),
    enabled: !!run?.workflowId,
    staleTime: Infinity,
  });
  const agents = useQuery(orpc.agents.list.queryOptions());

  if (check.error && !state) return <p role="alert" className="text-[14px] text-danger">Could not load this run.</p>;
  if (!state || !run) return null;

  const agentNames = new Map(agents.data?.map((a) => [a.id, a.name]));

  return (
    <>
      {run.workflowId && (
        <Link
          to="/settings/workflows/$id/runs"
          params={{ id: run.workflowId }}
          className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition hover:text-fg"
        >
          <ChevronLeft size={15} aria-hidden /> Runs
        </Link>
      )}
      <header className="mb-6">
        <h1 className="truncate text-[28px] font-semibold leading-tight tracking-tight">{workflow.data?.name ?? "Run"}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[14px] text-muted">
          <Status status={run.status} />
          <span>
            · Version {run.version} · Started {when.format(run.createdAt)} · {run.finishedAt ? `took ${duration(run.createdAt, run.finishedAt)}` : "still going"}
          </span>
        </p>
        {run.error && (
          <p role="alert" className="mt-3 whitespace-pre-wrap rounded-xl bg-surface px-4 py-3 text-[14px] text-danger shadow-card">
            {run.error}
          </p>
        )}
      </header>
      <RunSteps state={state} def={workflow.data?.def} agentNames={agentNames} />
    </>
  );
}
