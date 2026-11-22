import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { FormField } from "../settings/parts.tsx";
import { qualifiedName } from "@dispand/domain/plugins/names";
import { useStored } from "@/lib/message";

export type Operation = "created" | "updated" | "deleted" | "finished" | "failed";
export type ChangeConfig = { tableId: string; operations: Operation[]; fields?: string[] };
export type EventFire = { eventId: string; at: Date; status: string; runId?: string; message?: string };

const OPERATIONS: Operation[] = ["created", "updated", "deleted"];

/** The built-in kind of Jobs: another agent's Job created, finished or failed (its labels are `agents:jobTrigger` keys). */
const JOB = "job";
const JOB_OPERATIONS: Operation[] = ["created", "finished", "failed"];

/**
 * A table-change trigger's settings: which primitive table (or other agents' Jobs), which
 * changes (and, for a changed row, which fields), how many Jobs an hour at most, and what its latest events did.
 */
export function PrimitiveTriggerPanel({
  config,
  rateCap,
  events,
  onChange,
  onRateCap,
}: {
  config: ChangeConfig;
  rateCap: number;
  events: EventFire[];
  onChange: (config: ChangeConfig) => void;
  onRateCap: (cap: number) => void;
}) {
  const { t, i18n } = useTranslation("agents");
  const format = useFormat();
  const stored = useStored();
  const when = (date: Date) => format.dateTime(date, { dateStyle: "short", timeStyle: "short" });
  const tables = useQuery(orpc.tables.list.queryOptions());
  // Jobs are no table: no fields to read.
  const builtIn = config.tableId === JOB;
  const table = useQuery({ ...orpc.tables.get.queryOptions({ input: { id: config.tableId } }), enabled: !!config.tableId && !builtIn });
  const operationsOf = (tableId: string) => (tableId === JOB ? JOB_OPERATIONS : OPERATIONS);
  const operationLabel = (op: Operation) => (config.tableId === JOB ? t(`jobTrigger.operations.${op as "created"}`) : t(`change.op.${op as "created"}`));
  const primitives = (tables.data ?? []).filter((tb) => tb.primitive || tb.id === config.tableId);
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  return (
    <>
      <FormField
        label={t("change.table")}
        htmlFor="trigger-table"
        hint={primitives.length === 0 && tables.isSuccess ? t("change.tableNone") : undefined}
      >
        <select id="trigger-table" className={selectClass} value={config.tableId} onChange={(e) => onChange({ tableId: e.target.value, operations: config.operations.filter((op) => operationsOf(e.target.value).includes(op)) })}>
          <option value="">{t("change.pickTable")}</option>
          <option value={JOB}>{t("jobTrigger.option")}</option>
          {primitives.map((tb) => (
            <option key={tb.id} value={tb.id}>
              {qualifiedName(tb.plugin?.name ?? null, tb.name)}
            </option>
          ))}
        </select>
      </FormField>
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium text-muted">{t("change.startsWhen")}</legend>
        <div className="grid gap-1.5">
          {operationsOf(config.tableId).map((op) => (
            <label key={op} className="flex items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={config.operations.includes(op)}
                onChange={(e) => {
                  const operations = toggle(config.operations, op, e.target.checked);
                  // The field filter is for changed rows: it goes with them.
                  onChange(operations.includes("updated") ? { ...config, operations } : { tableId: config.tableId, operations });
                }}
                className="size-4 accent-[var(--color-accent)]"
              />
              {operationLabel(op)}
            </label>
          ))}
        </div>
      </fieldset>
      {!builtIn && config.operations.includes("updated") && table.data && (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-muted">{t("change.changeTo")}</legend>
          <div className="grid gap-1.5">
            <label className="flex items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={!config.fields}
                onChange={(e) => onChange({ tableId: config.tableId, operations: config.operations, ...(e.target.checked ? {} : { fields: [] }) })}
                className="size-4 accent-[var(--color-accent)]"
              />
              {t("change.anyField")}
            </label>
            {config.fields &&
              table.data.fields.map((f) => (
                <label key={f.id} className="flex items-center gap-2 pl-6 text-[14px]">
                  <input
                    type="checkbox"
                    checked={config.fields!.includes(f.id)}
                    onChange={(e) => onChange({ ...config, fields: toggle(config.fields!, f.id, e.target.checked) })}
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  {f.name}
                </label>
              ))}
          </div>
        </fieldset>
      )}
      <FormField label={t("change.cap")} htmlFor="trigger-rate-cap" hint={t("change.capHint")}>
        <Input id="trigger-rate-cap" type="number" min={1} max={1000} value={rateCap} onChange={(e) => onRateCap(Number(e.target.value))} />
      </FormField>
      {events.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">{t("change.recent")}</p>
          <ul aria-label={t("change.recent")} className="space-y-1.5 text-[14px]">
            {events.map((f) => (
              <li key={f.eventId} className="flex flex-wrap justify-between gap-x-3">
                <span className="text-muted">{when(f.at)}</span>
                <span className={f.status === "refused" || f.status === "out-of-scope" || f.status === "stopped" ? "text-danger" : undefined}>
                  {f.status === "started" && f.runId ? (
                    <a href={`/settings/workflows/runs/${f.runId}`}>{t("change.status.started")}</a>
                  ) : (
                    (i18n.exists(`agents:change.status.${f.status}`) ? t(`change.status.${f.status}` as never) : t("change.refused", { message: stored(f.message) ?? "" }))
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
