import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { JobAudit } from "../components/audit/AuditList.tsx";
import { RunConsults } from "../components/runs/RunConsults.tsx";
import { RunSteps } from "../components/runs/RunSteps.tsx";
import { StopRun } from "../components/runs/StopRun.tsx";
import { Status } from "../components/workflow/Runs.tsx";
import { nodesOf } from "@dispand/domain/workflows/model";
import { orpc } from "../lib/api.ts";
import { useAgentName } from "../lib/agent-name.ts";
import { useFormat } from "../lib/format.ts";
import { POLL_MS, useRun } from "../lib/run-watch.ts";
import { useStored } from "@/lib/message";

export const Route = createFileRoute("/_app/settings/workflows/runs/$runId")({ component: RunPage });

/** One run as it goes: each step's prompt, outputs, error, transcript and questions, to debug it. */
function RunPage() {
  const { t } = useTranslation("runs");
  const stored = useStored();
  const format = useFormat();
  const agentName = useAgentName();
  const { runId } = Route.useParams();
  const check = useQuery({
    ...orpc.runs.access.queryOptions({ input: { runId } }),
    retry: false,
    // Recheck permission even when the run is quiet or complete.
    refetchInterval: POLL_MS,
  });
  const canManage = check.isSuccess && check.data.canManage;
  const live = useRun(check.isSuccess ? runId : null);
  const state = live?.run.id === runId ? live : null;
  const run = state?.run;
  const workflow = useQuery({
    ...orpc.workflows.get.queryOptions({ input: { id: run?.workflowId ?? "", version: run?.version ?? 0 } }),
    enabled: canManage && !!run?.workflowId,
    staleTime: Infinity,
  });
  // A Job has no workflow: its definition is its own, and it goes back to its agent.
  const job = useQuery({ ...orpc.jobs.def.queryOptions({ input: { runId } }), enabled: run?.source === "agent", staleTime: Infinity });
  const agents = useQuery({ ...orpc.agents.list.queryOptions(), enabled: canManage });

  if (check.error) return <p role="alert" className="text-[14px] text-danger">{t("page.failed")}</p>;
  if (!state || !run) return null;

  const agentNames = new Map(agents.data?.map((a) => [a.id, agentName(a)]));
  // A Job of a deleted agent names it as it kept it, on its steps too.
  if (job.data) for (const node of nodesOf(job.data)) {
    if (node.agentId && !agentNames.has(node.agentId)) agentNames.set(node.agentId, run.deletedAgentName ?? node.name);
  }

  return (
    <>
      {canManage && (run.workflowId ? (
        // A deleted workflow has no page: its runs go back to the list of every run.
        workflow.data?.archived ? (
          <Link to="/settings/workflows/runs" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition hover:text-fg">
            <ChevronLeft size={15} aria-hidden /> {t("page.runs")}
          </Link>
        ) : (
          <Link
            to="/settings/workflows/$id/runs"
            params={{ id: run.workflowId }}
            className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition hover:text-fg"
          >
            <ChevronLeft size={15} aria-hidden /> {t("page.runs")}
          </Link>
        )
      ) : (
        run.source === "agent" &&
        (run.agentId ? (
          <Link
            to="/settings/agents/$id"
            params={{ id: run.agentId }}
            search={{ tab: "jobs" }}
            className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition hover:text-fg"
          >
            <ChevronLeft size={15} aria-hidden /> {agentNames.get(run.agentId) ?? t("page.agent")}
          </Link>
        ) : (
          // Its agent was deleted: no page to go back to.
          <p className="mb-3 text-[13px] text-muted">{run.deletedAgentName ?? t("deletedAgent")}</p>
        ))
      ))}
      <header className="mb-6">
        <h1 className="truncate text-[28px] font-semibold leading-tight tracking-tight">{workflow.data?.name ?? job.data?.trigger.field.label ?? t("page.run")}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[14px] text-muted">
          <Status status={run.status} />
          <span>
            {run.workflowId ? ` · ${t("page.version", { version: run.version })}` : ""} · {t("page.started", { when: format.dateTimeSeconds(run.createdAt) })} · {run.finishedAt ? t("page.took", { duration: format.duration(run.createdAt, run.finishedAt) }) : t("stillGoing")}
          </span>
        </p>
        {canManage && <div className="mt-3"><StopRun runId={run.id} status={run.status} /></div>}
        {run.error && (
          <p role="alert" className="mt-3 whitespace-pre-wrap rounded-xl bg-surface px-4 py-3 text-[14px] text-danger shadow-card">
            {stored(run.error)}
          </p>
        )}
      </header>
      {canManage && run.source === "agent" && <RunConsults runId={run.id} live={!run.finishedAt} />}
      <RunSteps state={state} def={workflow.data?.def ?? job.data} agentNames={agentNames} />
      {canManage && run.source === "agent" && <JobAudit jobId={run.id} live={!run.finishedAt} />}
    </>
  );
}
