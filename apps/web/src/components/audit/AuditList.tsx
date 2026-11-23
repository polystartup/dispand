import type { AuditDetails } from "@dispand/domain/audit/model";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { type api, orpc } from "../../lib/api.ts";
import { Empty } from "../settings/parts.tsx";
import { useAgentName } from "../../lib/agent-name.ts";
import { useFormat } from "../../lib/format.ts";
import { Status } from "../workflow/Runs.tsx";

type Filter = Omit<Parameters<typeof api.audit.list>[0], "cursor">;
type Row = Awaited<ReturnType<typeof api.audit.list>>["rows"][number];

/** `at` as stored has microseconds: read to the millisecond. */
const shownAt = (at: string) => new Date(`${at.slice(0, 23)}Z`);

function Actor({ row }: { row: Row }) {
  const { t } = useTranslation("audit");
  const agentName = useAgentName();
  if (row.actor.type === "user") return <span>{row.byYou ? t("actor.you") : (row.actorName ?? t("actor.formerMember"))}</span>;
  const agent = row.actorAgentId ? (row.agentName ? agentName({ name: row.agentName, builtIn: row.agentBuiltIn }) : t("actor.deletedAgent")) : null;
  if (row.actor.type === "scheduler") return <span>{agent ? t("actor.schedulerFor", { agent }) : t("actor.scheduler")}</span>;
  return (
    <span>
      {agent ?? t("actor.anAgent")}
      {" · "}
      <Link to="/settings/workflows/runs/$runId" params={{ runId: row.actor.runId }} className="text-accent hover:underline">
        {t("actor.itsJob")}
      </Link>
    </span>
  );
}

function Trace({ traceId, traceUrl }: { traceId: string; traceUrl: string | null }) {
  const { t } = useTranslation("audit");
  return (
    <span className="inline-flex items-center gap-1">
      {t("trace.label")}{" "}
      {traceUrl ? (
        <a href={traceUrl.replaceAll("{traceId}", encodeURIComponent(traceId))} target="_blank" rel="noreferrer noopener" className="font-mono text-accent hover:underline">
          {traceId}
        </a>
      ) : (
        <span className="font-mono">{traceId}</span>
      )}
      <Button variant="ghost" size="icon-xs" aria-label={t("trace.copy")} onClick={() => void navigator.clipboard.writeText(traceId).catch(() => undefined)}>
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
  const { t } = useTranslation("audit");
  const { dateTimeSeconds, number } = useFormat();
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

  if (pages.error && !pages.data) return <p role="alert" className="text-[14px] text-danger">{t("failed")}</p>;
  if (pages.data && rows.length === 0) {
    return (
      <Empty title={t("emptyTitle")} text={t("emptyText")}>
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
              <span className="font-medium">{t(`action.${row.action}`)}</span>
              {row.result !== "ok" && <Status status={row.result} />}
              <span className="text-muted">
                {t(`resource.${row.resourceType}`)}
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
              <time dateTime={row.at}>{dateTimeSeconds(shownAt(row.at))}</time>
              <Actor row={row} />
              {row.traceId && <Trace traceId={row.traceId} traceUrl={traceUrl} />}
            </div>
            {Object.keys(row.details).length > 0 && (
              <dl className="mt-1 flex flex-wrap gap-x-3 text-[13px]">
                {Object.entries(row.details).map(([key, value]) => (
                  <div key={key} className="flex gap-1">
                    <dt className="text-muted">{t(`detail.${key as keyof AuditDetails}`, { defaultValue: key })}</dt>
                    <dd className={key.endsWith("Id") ? "font-mono" : undefined}>{typeof value === "number" ? number(value) : String(value)}</dd>
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
            {t("loadMore")}
          </Button>
        </div>
      )}
    </>
  );
}

/** A Job's page: what the Job did and met, as Audit recorded it. */
export function JobAudit({ jobId, live }: { jobId: string; live: boolean }) {
  const { t } = useTranslation("audit");
  return (
    <section aria-label={t("title")} className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[13px] font-medium uppercase tracking-wide text-muted">{t("title")}</h2>
        <Link to="/audit" search={{ jobId }} className="text-[13px] text-accent hover:underline">
          {t("openInAudit")}
        </Link>
      </div>
      <AuditList filter={{ jobId }} live={live} />
    </section>
  );
}
