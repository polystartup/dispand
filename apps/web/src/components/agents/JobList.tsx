import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { type api, orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { Empty, List } from "../settings/parts.tsx";
import { Status, useTriggerText } from "../workflow/Runs.tsx";

type Run = Awaited<ReturnType<typeof api.runs.list>>[number];

/** The agent's latest Jobs, newest first, each with the trigger that made it (a chat Job, with its first message, a consulted Job with the agent that asked), and the agent a Job waits on while it consults. */
export function JobList({ agentId }: { agentId: string }) {
  const { t } = useTranslation(["agents", "runs"]);
  const format = useFormat();
  const triggerText = useTriggerText();
  const jobs = useQuery({
    ...orpc.runs.list.queryOptions({ input: { agentId } }),
    // Follows the Jobs still going.
    refetchInterval: (q) => (q.state.data?.some((r: Run) => !r.finishedAt) ? 5000 : false),
  });
  const triggers = useQuery(orpc.triggers.list.queryOptions({ input: { agentId } }));
  const names = new Map(triggers.data?.map((t) => [t.id, t.name]));

  if (jobs.error) return <p role="alert" className="text-[14px] text-danger">{t("agents:jobs.failed")}</p>;
  if (!jobs.data) return null;
  if (jobs.data.length === 0) {
    return (
      <Empty title={t("agents:jobs.emptyTitle")} text={t("agents:jobs.emptyText")}>
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
              {/* A consulted Job has no trigger: the agent that asked is its origin. */}
              <span className="truncate text-[15px] font-medium">{r.consultedBy ? t("runs:consultedBy", { agent: r.consultedBy }) : ((r.triggerId && names.get(r.triggerId)) || t("agents:jobs.deletedTrigger"))}</span>
              {/* A conversation is named by its first message, as the Assistant's list names it. */}
              <span className="min-w-0 truncate text-[13px] text-muted">{r.waitingOn ? t("agents:jobs.waitingOn", { agent: r.waitingOn }) : (r.title ?? (r.consultedBy ? null : triggerText(r.trigger)))}</span>
            </span>
            <span className="shrink-0 text-[13px] text-muted">
              {format.dateTimeSeconds(r.createdAt)} · {r.finishedAt ? format.duration(r.createdAt, r.finishedAt) : t("runs:stillGoing")}
            </span>
          </Link>
        </li>
      ))}
    </List>
  );
}
