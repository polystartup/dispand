import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Empty, List } from "../settings/parts.tsx";
import { Tabs } from "../settings/Tabs.tsx";
import { type api, orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { useAgentName } from "../../lib/agent-name.ts";

type Run = Awaited<ReturnType<typeof api.runs.list>>[number];

/** What started a run: "Manual", "Consulted by another agent", or "Scheduled for 5 Nov, 09:00" (Paris time). */
export function useTriggerText(): (trigger: Run["trigger"]) => string {
  const { t } = useTranslation("runs");
  const format = useFormat();
  return (trigger) => {
    if (trigger.type === "consult") return t("trigger.consult");
    if (trigger.type !== "schedule") return t("trigger.manual");
    return t("trigger.schedule", { when: format.dateTime(trigger.scheduledFor, { timeZone: "Europe/Paris", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) });
  };
}

const tones: Record<string, string> = {
  succeeded: "text-[#30d158]",
  failed: "text-danger",
  running: "text-fg",
  waiting: "text-fg",
  // Waiting for a slot of its harness.
  queued: "text-muted",
  expired: "text-muted",
  // An untaken branch: grey, like nothing happened there.
  skipped: "text-faint",
};

/** The agent of a Job: its name as it is now, or "Order drafter (Deleted)" once deleted; undefined while the names load. */
export function jobAgent(run: Pick<Run, "agentId" | "deletedAgentName">, names: Map<string, string>): string | undefined {
  return run.agentId ? names.get(run.agentId) : (run.deletedAgentName ?? undefined);
}

/** A run, step or question status, coloured. */
export function Status({ status }: { status: string }) {
  const { t, i18n } = useTranslation();
  const word = i18n.exists(`common:status.${status}`) ? t(`status.${status}` as never) : status;
  return <span className={cn("text-[13px] font-medium capitalize", tones[status] ?? "text-muted")}>{word}</span>;
}

/** The latest runs of one workflow, or of all of them (named then), newest first. */
export function RunList({ workflowId }: { workflowId?: string }) {
  const { t } = useTranslation("runs");
  const format = useFormat();
  const triggerText = useTriggerText();
  const agentName = useAgentName();
  const runs = useQuery({
    ...orpc.runs.list.queryOptions({ input: workflowId ? { workflowId } : {} }),
    // Follows the runs still going.
    refetchInterval: (q) => (q.state.data?.some((r: Run) => !r.finishedAt) ? 5000 : false),
  });
  const agents = useQuery({ ...orpc.agents.list.queryOptions(), enabled: !workflowId });
  const agentNames = new Map(agents.data?.map((a) => [a.id, agentName(a)]));

  if (runs.error) return <p role="alert" className="text-[14px] text-danger">{t("list.failed")}</p>;
  if (!runs.data) return null;
  if (runs.data.length === 0) {
    return (
      <Empty title={t("list.emptyTitle")} text={t("list.emptyText")}>
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
              <Status status={r.queued && r.status === "running" ? "queued" : r.status} />
              {!workflowId && <span className="truncate text-[15px] font-medium">{r.workflowId ? (r.workflowName ?? t("list.workflow")) : (jobAgent(r, agentNames) ?? t("list.job"))}</span>}
              <span className="text-[13px] text-muted">{triggerText(r.trigger)}</span>
            </span>
            <span className="shrink-0 text-[13px] text-muted">
              {format.dateTimeSeconds(r.createdAt)} · {r.finishedAt ? format.duration(r.createdAt, r.finishedAt) : t("stillGoing")}
            </span>
          </Link>
        </li>
      ))}
    </List>
  );
}

/** Tabs of the workflows page: the workflows, and every workflow's runs. */
export function WorkflowsTabs() {
  const { t } = useTranslation("runs");
  return (
    <Tabs
      tabs={[
        { to: "/settings/workflows", label: t("tabs.workflows") },
        { to: "/settings/workflows/runs", label: t("tabs.runs") },
      ]}
    />
  );
}

/** Tabs of one workflow: its editor and its runs. */
export function WorkflowTabs({ id }: { id: string }) {
  const { t } = useTranslation("runs");
  return (
    <Tabs
      tabs={[
        { to: `/settings/workflows/${id}`, label: t("tabs.editor") },
        { to: `/settings/workflows/${id}/runs`, label: t("tabs.runs") },
      ]}
    />
  );
}
