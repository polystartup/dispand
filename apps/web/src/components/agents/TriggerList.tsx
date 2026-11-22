import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import { Empty, List } from "../settings/parts.tsx";
import { useAt } from "../workflow/panels/ScheduleTriggerPanel.tsx";
import { localTimezone, TriggerSheet } from "./TriggerSheet.tsx";
import { useStored } from "@/lib/message";

export type Trigger = Awaited<ReturnType<typeof api.triggers.list>>[number];


/** The agent's triggers: what makes it work. Each opens its sheet; a manual one can go on Home. */
export function TriggerList({ agentId }: { agentId: string }) {
  const { t } = useTranslation("agents");
  const at = useAt();
  const stored = useStored();
  /** What a trigger does, in a line: how it starts and, for a schedule, when it next fires. */
  function summary(tr: Trigger): string {
    const c = tr.config;
    if (c.kind === "manual") return t(c.placement === "chat" ? "triggers.summary.chat" : "triggers.summary.button");
    if (c.kind === "primitive") {
      if (c.tableId === "job") return t(tr.enabled ? "jobTrigger.summary" : "jobTrigger.summaryPaused");
      return t(tr.enabled ? "triggers.summary.tableChange" : "triggers.summary.tableChangePaused");
    }
    if (c.kind === "poll") return tr.enabled ? t("triggers.summary.poll", { action: c.action }) : t("triggers.summary.pollPaused");
    if (!tr.enabled) return t("triggers.summary.schedulePaused");
    return tr.nextFireAt ? t("triggers.summary.scheduleNext", { when: at(tr.nextFireAt, c.timezone), timezone: c.timezone }) : t("triggers.summary.schedule");
  }
  const queryClient = useQueryClient();
  const triggers = useQuery(orpc.triggers.list.queryOptions({ input: { agentId } }));
  const home = useQuery(orpc.pages.home.queryOptions());
  const addToHome = useMutation(orpc.widgets.create.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.pages.key() }) }));
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: (triggerId: string) => api.jobs.start({ triggerId, timezone: localTimezone() }),
    onSuccess: ({ runId }) => {
      void queryClient.invalidateQueries({ queryKey: orpc.triggers.key() });
      void navigate({ to: "/settings/workflows/runs/$runId", params: { runId } });
    },
  });
  // undefined: closed; null: a new trigger.
  const [open, setOpen] = useState<Trigger | null | undefined>(undefined);
  const onHome = (id: string) => home.data?.widgets.some((w) => w.type === "trigger-form" && w.triggerId === id) ?? false;

  if (triggers.error) return <p role="alert" className="text-[14px] text-danger">{t("triggers.failed")}</p>;
  if (!triggers.data) return null;
  const add = (
    <Button onClick={() => setOpen(null)}>
      <Plus aria-hidden />
      {t("triggers.new")}
    </Button>
  );
  return (
    <>
      {triggers.data.length === 0 ? (
        <Empty title={t("triggers.emptyTitle")} text={t("triggers.emptyText")}>
          {add}
        </Empty>
      ) : (
        <>
          <div className="mb-4 flex justify-end">{add}</div>
          <List>
            {triggers.data.map((tr) => {
              const last = tr.lastFires[0];
              return (
                <li key={tr.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
                  <button type="button" onClick={() => setOpen(tr)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[15px] font-medium">{tr.name}</span>
                    <span className="block text-[13px] text-muted">{summary(tr)}</span>
                    {last && (
                      <span className={`block text-[13px] ${last.status === "refused" ? "text-danger" : "text-faint"}`}>
                        {t(last.message ? "triggers.lastMessage" : "triggers.last", {
                          when: at(last.scheduledFor, tr.config.kind === "schedule" ? tr.config.timezone : "UTC"),
                          status: t(`triggers.fire.${last.status}`),
                          message: stored(last.message),
                        })}
                      </span>
                    )}
                  </button>
                  {tr.config.kind === "manual" && tr.config.placement === "button" && (
                    <Button variant="outline" size="sm" aria-label={t("triggers.startLabel", { name: tr.name })} disabled={!tr.enabled || start.isPending} onClick={() => start.mutate(tr.id)}>
                      {t("triggers.start")}
                    </Button>
                  )}
                  {tr.config.kind === "manual" &&
                    (onHome(tr.id) ? (
                      <span className="text-[13px] text-muted">{t("triggers.onHome")}</span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("triggers.addToHomeLabel", { name: tr.name })}
                        disabled={!home.data || addToHome.isPending}
                        onClick={() => home.data && addToHome.mutate({ pageId: home.data.id, type: "trigger-form", triggerId: tr.id })}
                      >
                        {t("triggers.addToHome")}
                      </Button>
                    ))}
                </li>
              );
            })}
          </List>
          {(addToHome.error ?? start.error) && (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {(addToHome.error ?? start.error)!.message}
            </p>
          )}
        </>
      )}
      {open !== undefined && <TriggerSheet key={open?.id ?? "new"} agentId={agentId} trigger={open ?? undefined} onClose={() => setOpen(undefined)} />}
    </>
  );
}
