import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/Placeholder.tsx";
import { List, Section, StatusDot } from "../components/settings/parts.tsx";
import { orpc, type api } from "../lib/api.ts";
import { useFormat } from "../lib/format.ts";
import { useStored } from "../lib/message.ts";
import { useWorkspaces } from "../lib/workspace.tsx";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/system")({ component: System });

/** What a workspace's managers check when something seems wrong: the scheduler, the runners and the polls that fail. */
function System() {
  const { t } = useTranslation("settings");
  const role = useWorkspaces().current?.role;
  const manages = role === "owner" || role === "manager";
  // The scheduler ticks every 15 s: refreshed as often.
  const status = useQuery(orpc.system.status.queryOptions({ enabled: manages, refetchInterval: 15_000 }));
  const { dateTimeSeconds } = useFormat();
  return (
    <>
      <PageHeader title={t("system.title")} subtitle={t("system.subtitle")} />
      {!manages ? (
        <p>{t("system.managersOnly")}</p>
      ) : status.error && !status.data ? (
        <p role="alert" className="text-[14px] text-danger">
          {t("system.loadFailed")}
        </p>
      ) : !status.data ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <div className="space-y-8">
          {/* What follows is the last answer: an operator must not read it as live while the server, or the network, is down. */}
          {(status.isRefetchError || status.isPaused) && (
            <p role="alert" className="text-[14px] text-danger">
              {t("system.stale", { time: dateTimeSeconds(status.dataUpdatedAt) })}
            </p>
          )}
          <Scheduler scheduler={status.data.scheduler} />
          <Runners protocolVersion={status.data.protocolVersion} runners={status.data.runners} />
          <Polls polls={status.data.failingPolls} />
        </div>
      )}
    </>
  );
}

type Status = Awaited<ReturnType<typeof api.system.status>>;

const card = "rounded-2xl bg-surface px-5 py-4 text-[14px] shadow-card";

function Scheduler({ scheduler }: { scheduler: Status["scheduler"] }) {
  const { t } = useTranslation("settings");
  const { duration } = useFormat();
  const age = scheduler && duration(new Date(0), new Date(scheduler.sinceTickMs));
  return (
    <Section id="system-scheduler" title={t("system.scheduler.title")}>
      <p role={scheduler?.stale ? "alert" : undefined} className={cn(card, scheduler?.stale && "text-danger")}>
        {!scheduler ? t("system.scheduler.none") : scheduler.stale ? t("system.scheduler.stale", { age }) : t("system.scheduler.ok", { age })}
      </p>
    </Section>
  );
}

function Runners({ protocolVersion, runners }: { protocolVersion: number; runners: Status["runners"] }) {
  const { t } = useTranslation("settings");
  const { number } = useFormat();
  return (
    <Section id="system-runners" title={t("system.runners.title")}>
      <p className="text-[13px] text-muted">{t("system.runners.server", { version: number(protocolVersion) })}</p>
      {runners.length === 0 ? (
        <p className={card}>{t("system.runners.none")}</p>
      ) : (
        <List>
          {runners.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-medium">{r.name}</span>
                <span className="block truncate text-[13px] text-muted">
                  {r.protocolVersion === null ? t("system.runners.never") : t("system.runners.protocol", { version: number(r.protocolVersion) })}
                </span>
              </span>
              <StatusDot status={r.status} />
            </li>
          ))}
        </List>
      )}
    </Section>
  );
}

function Polls({ polls }: { polls: Status["failingPolls"] }) {
  const { t } = useTranslation(["settings", "agents"]);
  const { dateTime } = useFormat();
  const stored = useStored();
  return (
    <Section id="system-polls" title={t("system.polls.title")}>
      <p className="text-[13px] text-muted">{polls.length === 0 ? t("system.polls.none") : t("system.polls.count", { count: polls.length })}</p>
      {polls.length > 0 && (
        <List>
          {polls.map((p) => (
            <li key={p.triggerId} className="px-5 py-4">
              <Link to="/settings/agents/$id" params={{ id: p.agentId }} className="block truncate text-[15px] font-medium hover:underline">
                {t("system.polls.trigger", { trigger: p.triggerName, agent: p.agentName })}
              </Link>
              <p className="text-[13px] text-danger [overflow-wrap:anywhere]">{t("agents:poll.failed", { message: stored(p.message) ?? "" })}</p>
              <p className="text-[12px] text-faint">
                <time dateTime={p.at.toISOString()}>{dateTime(p.at)}</time>
              </p>
            </li>
          ))}
        </List>
      )}
    </Section>
  );
}
