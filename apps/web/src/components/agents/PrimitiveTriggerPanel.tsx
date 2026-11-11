import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { FormField } from "../settings/parts.tsx";

export type Operation = "created" | "updated" | "deleted" | "answered" | "expired";
export type ChangeConfig = { tableId: string; operations: Operation[]; fields?: string[] };
export type EventFire = { eventId: string; at: Date; status: string; runId?: string; message?: string };

const OPERATIONS: [Operation, string][] = [
  ["created", "A row is created"],
  ["updated", "A row is changed"],
  ["deleted", "A row is deleted"],
];

/** The built-in kind of Questions and Approvals, picked in place of a table. */
const INTERACTION = "interaction";
const INTERACTION_OPERATIONS: [Operation, string][] = [
  ["created", "One is asked"],
  ["answered", "One is answered"],
  ["expired", "One expires"],
];

const statusText: Record<string, string> = {
  started: "Started a Job",
  deferred: "Waiting: the hour's cap is reached, or a Job is still going",
  "skipped-same-agent": "Skipped: this agent's own Job made the change",
  stopped: "Stopped: its work was declined at a checkpoint",
  "out-of-scope": "Skipped: the agent may not read this",
};

const when = (date: Date) => new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);

/**
 * A table-change trigger's settings: which primitive table (or Questions and Approvals), which
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
  const tables = useQuery(orpc.tables.list.queryOptions());
  const interaction = config.tableId === INTERACTION;
  const table = useQuery({ ...orpc.tables.get.queryOptions({ input: { id: config.tableId } }), enabled: !!config.tableId && !interaction });
  const primitives = (tables.data ?? []).filter((t) => t.primitive || t.id === config.tableId);
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  return (
    <>
      <FormField
        label="Table"
        htmlFor="trigger-table"
        hint={primitives.length === 0 && tables.isSuccess ? "No table's changes are events yet: open a table's menu, Events and parent." : undefined}
      >
        <select id="trigger-table" className={selectClass} value={config.tableId} onChange={(e) => onChange({ tableId: e.target.value, operations: config.operations.filter((op) => (e.target.value === INTERACTION ? INTERACTION_OPERATIONS : OPERATIONS).some(([o]) => o === op)) })}>
          <option value="">Pick a table</option>
          <option value={INTERACTION}>A Question or an Approval</option>
          {primitives.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </FormField>
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium text-muted">Starts when</legend>
        <div className="grid gap-1.5">
          {(interaction ? INTERACTION_OPERATIONS : OPERATIONS).map(([op, label]) => (
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
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {!interaction && config.operations.includes("updated") && table.data && (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-muted">A change to</legend>
          <div className="grid gap-1.5">
            <label className="flex items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={!config.fields}
                onChange={(e) => onChange({ tableId: config.tableId, operations: config.operations, ...(e.target.checked ? {} : { fields: [] }) })}
                className="size-4 accent-[var(--color-accent)]"
              />
              Any field
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
      <FormField label="At most, Jobs an hour" htmlFor="trigger-rate-cap" hint="Past it, changes wait their turn: none is lost.">
        <Input id="trigger-rate-cap" type="number" min={1} max={1000} value={rateCap} onChange={(e) => onRateCap(Number(e.target.value))} />
      </FormField>
      {events.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Recent</p>
          <ul aria-label="Recent" className="space-y-1.5 text-[14px]">
            {events.map((f) => (
              <li key={f.eventId} className="flex flex-wrap justify-between gap-x-3">
                <span className="text-muted">{when(f.at)}</span>
                <span className={f.status === "refused" || f.status === "out-of-scope" || f.status === "stopped" ? "text-danger" : undefined}>
                  {f.status === "started" && f.runId ? (
                    <a href={`/settings/workflows/runs/${f.runId}`}>{statusText.started}</a>
                  ) : (
                    (statusText[f.status] ?? `Refused: ${f.message ?? ""}`)
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
