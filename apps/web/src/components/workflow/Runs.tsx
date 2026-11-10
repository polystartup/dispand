import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Empty, List } from "../settings/parts.tsx";
import { Tabs } from "../settings/Tabs.tsx";
import { type api, orpc } from "../../lib/api.ts";

type Run = Awaited<ReturnType<typeof api.runs.list>>[number];

export const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const paris = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** What started a run: "Manual", or "Scheduled for 5 Nov, 09:00" (Paris time). */
export function triggerText(trigger: Run["trigger"]): string {
  return trigger.type === "schedule" ? `Scheduled for ${paris.format(new Date(trigger.scheduledFor))}` : "Manual";
}

/** How long from `from` to `to` (or until now), as "1 h 2 min", "3 min 4 s" or "5 s". */
export function duration(from: Date, to: Date | null): string {
  const s = Math.max(0, Math.round(((to ?? new Date()).getTime() - from.getTime()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${s} s`;
}

const tones: Record<string, string> = {
  succeeded: "text-[#30d158]",
  failed: "text-danger",
  running: "text-fg",
  waiting: "text-fg",
  expired: "text-muted",
  // An untaken branch: grey, like nothing happened there.
  skipped: "text-faint",
};

/** A run, step or question status, coloured. */
export function Status({ status }: { status: string }) {
  return <span className={cn("text-[13px] font-medium capitalize", tones[status] ?? "text-muted")}>{status}</span>;
}

/** The latest runs of one workflow, or of all of them (named then), newest first. */
export function RunList({ workflowId }: { workflowId?: string }) {
  const runs = useQuery({
    ...orpc.runs.list.queryOptions({ input: workflowId ? { workflowId } : {} }),
    // Follows the runs still going.
    refetchInterval: (q) => (q.state.data?.some((r: Run) => !r.finishedAt) ? 5000 : false),
  });
  const workflows = useQuery({ ...orpc.workflows.list.queryOptions(), enabled: !workflowId });
  const names = new Map(workflows.data?.map((w) => [w.id, w.name]));

  if (runs.error) return <p role="alert" className="text-[14px] text-danger">Could not load the runs.</p>;
  if (!runs.data) return null;
  if (runs.data.length === 0) {
    return (
      <Empty title="No run yet" text="Runs started from Home show up here, with what each step did.">
        {null}
      </Empty>
    );
  }
  return (
    <List>
      {runs.data.map((r) => (
        <li key={r.id}>
          <Link
            to="/settings/workflows/runs/$runId"
            params={{ runId: r.id }}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-4 transition hover:bg-hover"
          >
            <span className="flex min-w-0 items-center gap-3">
              <Status status={r.status} />
              {!workflowId && <span className="truncate text-[15px] font-medium">{names.get(r.workflowId) ?? "Workflow"}</span>}
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

/** Tabs of the workflows page: the workflows, and every workflow's runs. */
export function WorkflowsTabs() {
  return (
    <Tabs
      tabs={[
        { to: "/settings/workflows", label: "Workflows" },
        { to: "/settings/workflows/runs", label: "Runs" },
      ]}
    />
  );
}

/** Tabs of one workflow: its editor and its runs. */
export function WorkflowTabs({ id }: { id: string }) {
  return (
    <Tabs
      tabs={[
        { to: `/settings/workflows/${id}`, label: "Editor" },
        { to: `/settings/workflows/${id}/runs`, label: "Runs" },
      ]}
    />
  );
}
