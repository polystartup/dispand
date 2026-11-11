import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type api, orpc } from "../../lib/api.ts";
import { Empty, List } from "../settings/parts.tsx";
import { duration, Status, triggerText, when } from "../workflow/Runs.tsx";

type Run = Awaited<ReturnType<typeof api.runs.list>>[number];

/** The agent's latest Jobs, newest first, each with the trigger that made it. */
export function JobList({ agentId }: { agentId: string }) {
  const jobs = useQuery({
    ...orpc.runs.list.queryOptions({ input: { agentId } }),
    // Follows the Jobs still going.
    refetchInterval: (q) => (q.state.data?.some((r: Run) => !r.finishedAt) ? 5000 : false),
  });
  const triggers = useQuery(orpc.triggers.list.queryOptions({ input: { agentId } }));
  const names = new Map(triggers.data?.map((t) => [t.id, t.name]));

  if (jobs.error) return <p role="alert" className="text-[14px] text-danger">Could not load the Jobs.</p>;
  if (!jobs.data) return null;
  if (jobs.data.length === 0) {
    return (
      <Empty title="No Job yet" text="Each time one of this agent's triggers fires, the Job it makes shows up here.">
        {null}
      </Empty>
    );
  }
  return (
    <List>
      {jobs.data.map((r) => (
        <li key={r.id}>
          <Link
            to="/settings/workflows/runs/$runId"
            params={{ runId: r.id }}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-4 transition hover:bg-hover"
          >
            <span className="flex min-w-0 items-center gap-3">
              <Status status={r.queued && r.status === "running" ? "queued" : r.status} />
              <span className="truncate text-[15px] font-medium">{(r.triggerId && names.get(r.triggerId)) || "Deleted trigger"}</span>
              <span className="text-[13px] text-muted">{triggerText(r.trigger)}</span>
            </span>
            <span className="shrink-0 text-[13px] text-muted">
              {when.format(r.createdAt)} · {r.finishedAt ? duration(r.createdAt, r.finishedAt) : "still going"}
            </span>
          </Link>
        </li>
      ))}
    </List>
  );
}
