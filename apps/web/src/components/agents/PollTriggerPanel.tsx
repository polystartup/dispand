import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { FormField } from "../settings/parts.tsx";

/** A poll's settings as the sheet edits them: the arguments as the JSON text typed; the continuation as a preset gave it. */
export type PollForm = {
  toolId: string;
  action: string;
  arguments: string;
  itemsPath: string;
  idPath: string;
  interval: number;
  continuation?: { path: string; query?: string; argument: string };
};
type PollItem = { itemId: string; status: string; runId?: string; message?: string };
export type PollRecord = { at: Date; status: string; found: number; fresh: number; message?: string; items: PollItem[] };


/**
 * A poll trigger's settings: the tool and one of its actions a poll may read, the arguments
 * (`{{lastPoll}}` for "newer than"), where the items and their ids are, how often, how many Jobs
 * an hour at most, and what its latest polls found.
 */
export function PollTriggerPanel({
  agentId,
  config,
  rateCap,
  polls,
  onChange,
  onRateCap,
}: {
  agentId: string;
  config: PollForm;
  rateCap: number;
  polls: PollRecord[];
  onChange: (config: PollForm) => void;
  onRateCap: (cap: number) => void;
}) {
  const { t, i18n } = useTranslation("agents");
  const format = useFormat();
  const when = (date: Date) => format.dateTime(date, { dateStyle: "short", timeStyle: "short" });
  const pollText = (p: PollRecord): string => {
    const values = { found: format.number(p.found), fresh: format.number(p.fresh), message: p.message };
    switch (p.status) {
      case "calling":
        return t("poll.calling");
      case "baseline":
        return t(p.message ? "poll.baselineNote" : "poll.baseline", values);
      case "polled":
        return t(p.message ? "poll.polledNote" : "poll.polled", values);
      case "skipped":
        return t("poll.skipped", { message: p.message ?? "" });
      case "failed":
        return t("poll.failed", { message: p.message ?? "" });
      default:
        return p.status;
    }
  };
  const itemText = (i: PollItem): string => {
    const status = i18n.exists(`agents:poll.item.${i.status}`) ? t(`poll.item.${i.status}` as never) : i.status;
    return i.message && i.status !== "deferred" ? t("poll.item.withMessage", { status, message: i.message }) : status;
  };
  // The agent's own tools, chosen or through its skills: a poll reads no more than its agent may.
  const agent = useQuery(orpc.agents.get.queryOptions({ input: { id: agentId } }));
  const actions = useQuery({ ...orpc.tools.pollable.queryOptions({ input: { id: config.toolId } }), enabled: !!config.toolId });
  // A tool from the catalog comes with its poll preset: picking it fills the settings.
  const tools = useQuery(orpc.tools.list.queryOptions());
  const catalog = useQuery(orpc.tools.catalog.queryOptions({ input: {} }));
  const presetOf = (toolId: string) => {
    const catalogId = tools.data?.find((t) => t.id === toolId)?.catalogId;
    return catalog.data?.find((e) => e.id === catalogId)?.poll;
  };
  function pickTool(toolId: string) {
    const preset = presetOf(toolId);
    if (!preset) return onChange({ ...config, toolId, action: "", continuation: undefined });
    onChange({
      ...config,
      toolId,
      action: preset.action,
      arguments: JSON.stringify(preset.arguments, null, 2),
      itemsPath: preset.itemsPath,
      idPath: preset.idPath,
      continuation: preset.continuation,
    });
  }
  // Only what a poll may read now, and the action already chosen (the server says why it no longer may).
  const pollable = (actions.data ?? []).filter((a) => a.pollable || a.name === config.action);

  return (
    <>
      <FormField label={t("poll.tool")} htmlFor="trigger-tool" hint={t("poll.toolHint")}>
        <select id="trigger-tool" className={selectClass} value={config.toolId} onChange={(e) => pickTool(e.target.value)}>
          <option value="">{t("poll.pickTool")}</option>
          {(agent.data?.tools ?? []).map((t) => (
            <option key={t.toolId} value={t.toolId}>
              {t.name}
            </option>
          ))}
        </select>
      </FormField>
      {config.toolId && (
        <FormField
          label={t("poll.action")}
          htmlFor="trigger-action"
          hint={actions.isSuccess && pollable.length === 0 ? t("poll.actionNone") : t("poll.actionHint")}
        >
          <select id="trigger-action" className={selectClass} value={config.action} onChange={(e) => onChange({ ...config, action: e.target.value })}>
            <option value="">{t("poll.pickAction")}</option>
            {pollable.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </FormField>
      )}
      {config.toolId && presetOf(config.toolId)?.action === config.action && <p className="text-[13px] text-muted">{t("poll.preset")}</p>}
      <FormField
        label={t("poll.arguments")}
        htmlFor="trigger-arguments"
        hint={t("poll.argumentsHint", { lastPoll: "{{lastPoll}}", lastPollEpoch: "{{lastPollEpoch}}" })}
      >
        <Textarea id="trigger-arguments" rows={3} className="font-mono text-[13px]" value={config.arguments} onChange={(e) => onChange({ ...config, arguments: e.target.value })} />
      </FormField>
      <FormField label={t("poll.itemsAt")} htmlFor="trigger-items-path" hint={t("poll.itemsAtHint")}>
        <Input id="trigger-items-path" value={config.itemsPath} maxLength={200} onChange={(e) => onChange({ ...config, itemsPath: e.target.value })} />
      </FormField>
      <FormField label={t("poll.idAt")} htmlFor="trigger-id-path" hint={t("poll.idAtHint")}>
        <Input id="trigger-id-path" value={config.idPath} maxLength={200} onChange={(e) => onChange({ ...config, idPath: e.target.value })} />
      </FormField>
      {config.continuation && (
        <p className="text-[13px] text-muted">
          <Trans
            t={t}
            i18nKey="poll.continuation"
            values={{ path: config.continuation.path, argument: config.continuation.argument }}
            components={[<code key="path" className="font-mono" />, <code key="argument" className="font-mono" />]}
          />
        </p>
      )}
      <FormField label={t("poll.every")} htmlFor="trigger-interval">
        <Input id="trigger-interval" type="number" min={1} max={1440} value={config.interval / 60} onChange={(e) => onChange({ ...config, interval: Math.round(Number(e.target.value) * 60) })} />
      </FormField>
      <FormField label={t("poll.cap")} htmlFor="trigger-rate-cap" hint={t("poll.capHint")}>
        <Input id="trigger-rate-cap" type="number" min={1} max={1000} value={rateCap} onChange={(e) => onRateCap(Number(e.target.value))} />
      </FormField>
      {polls.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">{t("poll.latest")}</p>
          <ul aria-label={t("poll.latest")} className="space-y-2 text-[14px]">
            {polls.map((p) => (
              <li key={p.at.toISOString()}>
                <div className="flex flex-wrap justify-between gap-x-3">
                  <span className="text-muted">{when(p.at)}</span>
                  <span className={p.status === "failed" || p.status === "skipped" ? "text-danger" : undefined}>{pollText(p)}</span>
                </div>
                {p.items.length > 0 && p.status === "polled" && (
                  <ul className="mt-1 space-y-0.5 pl-4 text-[13px]">
                    {p.items.map((i) => (
                      <li key={i.itemId} className="flex flex-wrap justify-between gap-x-3">
                        <span className="truncate font-mono">{i.itemId}</span>
                        {i.status === "started" && i.runId ? (
                          <a href={`/settings/workflows/runs/${i.runId}`}>{t("poll.item.started")}</a>
                        ) : (
                          <span className={i.status === "deferred" ? undefined : "text-danger"}>{itemText(i)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
