import type { AuditAction, AuditDetails, AuditResource } from "@dispand/domain/audit/model";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type api, orpc } from "../../lib/api.ts";
import { Empty } from "../settings/parts.tsx";
import { Status, when } from "../workflow/Runs.tsx";

type Filter = Omit<Parameters<typeof api.audit.list>[0], "cursor">;
type Row = Awaited<ReturnType<typeof api.audit.list>>["rows"][number];

/** Each action in words. Typed on the whole list: an action added without its words doesn't compile. */
export const ACTION_WORDS: Record<AuditAction, string> = {
  "job.created": "Job created",
  "job.queued": "Job queued for its harness",
  "job.started": "Job started",
  "job.waiting": "Job waiting for an answer",
  "job.finished": "Job finished",
  "job.failed": "Job failed",
  "job.skipped": "No Job started",
  "checkpoint.reached": "Checkpoint reached",
  "checkpoint.answered": "Checkpoint answered",
  "question.asked": "Question asked",
  "question.answered": "Question answered",
  "question.expired": "Question expired",
  "consult.asked": "Agent consulted",
  "consult.ended": "Consult ended",
  "platform.call": "Dispand tool called",
  "tool.call": "Tool action called",
  "poll.run": "Tool polled",
  "event.recorded": "Row change recorded",
  "memory.written": "Memory written",
};

const RESOURCE_WORDS: Record<AuditResource, string> = {
  job: "Job",
  root: "Root cause",
  question: "Question",
  consult: "Consult",
  tool: "Tool",
  trigger: "Trigger",
  poll: "Poll",
  table: "Table",
  row: "Row",
  field: "Field",
  agent: "Agent",
  harness: "Harness",
  proposal: "Proposal",
  plugin: "Plugin",
  memory: "Memory",
  workspace: "Workspace",
};

/** Each detail's label. */
const DETAIL_LABELS: Record<keyof AuditDetails, string> = {
  agentId: "Agent id",
  harnessId: "Harness id",
  runnerId: "Runner id",
  triggerId: "Trigger id",
  rootId: "Root cause",
  questionId: "Question",
  consultedJobId: "Consulted Job",
  proposalId: "Proposal",
  toolId: "Tool id",
  tableId: "Table id",
  rowId: "Row",
  eventId: "Event",
  memoryId: "Memory",
  agentName: "Agent",
  harnessName: "Harness",
  runnerName: "Runner",
  triggerName: "Trigger",
  toolName: "Tool",
  tableName: "Table",
  causeKind: "Cause",
  firing: "Firing",
  questionKind: "Kind",
  decision: "Decision",
  answeredBy: "Answered by",
  outcome: "Outcome",
  reason: "Reason",
  operation: "Operation",
  scope: "Scope",
  status: "Status",
  item: "Item",
  items: "Items",
  jobs: "Jobs",
  fields: "Fields",
  events: "Events",
  found: "Found",
  tool: "Dispand tool",
  action: "Action",
};

/** `at` as stored has microseconds: shown to the second. */
const shown = (at: string) => when.format(new Date(`${at.slice(0, 23)}Z`));

function Actor({ row }: { row: Row }) {
  if (row.actor.type === "user") return <span>You</span>;
  const agent = row.actorAgentId ? (row.agentName ?? "A deleted agent") : null;
  if (row.actor.type === "scheduler") return <span>Scheduler{agent ? ` · for ${agent}` : ""}</span>;
  return (
    <span>
      {agent ?? "An agent"}
      {" · "}
      <Link to="/settings/workflows/runs/$runId" params={{ runId: row.actor.runId }} className="text-accent hover:underline">
        its Job
      </Link>
    </span>
  );
}

function Trace({ traceId, traceUrl }: { traceId: string; traceUrl: string | null }) {
  return (
    <span className="inline-flex items-center gap-1">
      Trace{" "}
      {traceUrl ? (
        <a href={traceUrl.replaceAll("{traceId}", encodeURIComponent(traceId))} target="_blank" rel="noreferrer noopener" className="font-mono text-accent hover:underline">
          {traceId}
        </a>
      ) : (
        <span className="font-mono">{traceId}</span>
      )}
      <Button variant="ghost" size="icon-xs" aria-label="Copy the trace id" onClick={() => void navigator.clipboard.writeText(traceId).catch(() => undefined)}>
        <Copy aria-hidden />
      </Button>
    </span>
  );
}

/**
 * Audit rows, newest first, as `filter` narrows them (design 6.8): when, who, what, on what, how
 * it ended, the ids and names it names, and its trace, with a link where traces are opened
 * (`DISPAND_TRACE_URL`). "Load more" reads the next page.
 */
export function AuditList({ filter = {}, live = false }: { filter?: Filter; live?: boolean }) {
  const options = orpc.audit.list.infiniteOptions({
    input: (cursor: string | undefined) => ({ ...filter, ...(cursor ? { cursor } : {}) }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const pages = useInfiniteQuery({
    ...options,
    // A Job ending is read once more, whatever the polling had reached: its last rows came with it.
    queryKey: [...options.queryKey, live],
    // A Job still going writes rows as it goes.
    refetchInterval: live ? 5000 : false,
  });
  const trace = useQuery({ ...orpc.audit.traceUrl.queryOptions(), staleTime: Infinity });
  const rows = pages.data?.pages.flatMap((p) => p.rows) ?? [];
  const traceUrl = trace.data?.traceUrl ?? null;

  if (pages.error && !pages.data) return <p role="alert" className="text-[14px] text-danger">Could not load Audit.</p>;
  if (pages.data && rows.length === 0) {
    return (
      <Empty title="Nothing recorded yet" text="What your agents do shows up here.">
        <span />
      </Empty>
    );
  }
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-surface shadow-card">
        {rows.map((row) => (
          <li key={row.id} className="px-5 py-3 text-[14px]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{ACTION_WORDS[row.action]}</span>
              {row.result !== "ok" && <Status status={row.result} />}
              <span className="text-muted">
                {RESOURCE_WORDS[row.resourceType]}
                {row.resourceId && row.resourceType === "job" ? (
                  <>
                    {" "}
                    <Link to="/settings/workflows/runs/$runId" params={{ runId: row.resourceId }} className="font-mono text-accent hover:underline">
                      {row.resourceId}
                    </Link>
                  </>
                ) : (
                  row.resourceId && <span className="font-mono"> {row.resourceId}</span>
                )}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[13px] text-muted">
              <time dateTime={row.at}>{shown(row.at)}</time>
              <Actor row={row} />
              {row.traceId && <Trace traceId={row.traceId} traceUrl={traceUrl} />}
            </div>
            {Object.keys(row.details).length > 0 && (
              <dl className="mt-1 flex flex-wrap gap-x-3 text-[13px]">
                {Object.entries(row.details).map(([key, value]) => (
                  <div key={key} className="flex gap-1">
                    <dt className="text-muted">{DETAIL_LABELS[key as keyof AuditDetails] ?? key}</dt>
                    <dd className={key.endsWith("Id") ? "font-mono" : undefined}>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
      {pages.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

/** A Job's page: what the Job did and met, as Audit recorded it. */
export function JobAudit({ jobId, live }: { jobId: string; live: boolean }) {
  return (
    <section aria-label="Audit" className="mt-8">
      <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wide text-muted">Audit</h2>
      <AuditList filter={{ jobId }} live={live} />
    </section>
  );
}
