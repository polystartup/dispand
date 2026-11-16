import type { OutputField } from "@dispand/runner-protocol";
import { FILTER_OPS, takesValue, type FilterOp } from "@dispand/domain/data/query";
import { DATA_OUTPUTS, setDataFields, setSource, type DataTarget, type TableSchema } from "@dispand/domain/workflows/data-steps";
import { slugify, type DataFilter, type DataStep, type Source, type WorkflowDef } from "@dispand/domain/workflows/model";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Plus, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "../../settings/parts.tsx";
import { FIELD_TYPE_UI } from "../../data/field-types.ts";
import { selectClass } from "../../data/NewFieldPopover.tsx";
import { SourcePicker } from "../SourcePicker.tsx";

const ACTIONS: DataStep["action"][] = ["create-row", "update-row", "find-rows"];

/** "Create row · Projects", for the step's card. */
export function describeDataStep(t: TFunction<"workflows">, step: DataStep, tableNames: Map<string, string>): string {
  return t("dataPanel.card", { action: t(`dataPanel.action.${step.action}`), table: tableNames.get(step.tableId) ?? t("dataPanel.chooseTable") });
}

/** The step reset for `action` on `tableId`: inputs and filters start over, its loop stays. */
function resetStep(step: DataStep, action: DataStep["action"], tableId: string): DataStep {
  const { id, key, type, name, loopId } = step;
  const base = { id, key, type, name, tableId, ...(loopId === undefined ? {} : { loopId }) };
  if (action === "create-row") return { ...base, action, inputs: [] };
  if (action === "update-row") return { ...base, action, rowId: { type: "value", value: "" }, inputs: [] };
  return { ...base, action, filters: [], limit: 20 };
}

/** A data step's body: action, table, then the fields it sets or the filters it finds rows with. */
export function DataPanel({
  def,
  step,
  tables,
  tableList,
  expected,
  onChange,
}: {
  def: WorkflowDef;
  step: DataStep;
  /** The tables the workflow's data steps use, with their fields. */
  tables: TableSchema[];
  /** Every table of the owner, to choose from. */
  tableList: { id: string; name: string }[];
  expected: Record<string, OutputField[]>;
  onChange: (def: WorkflowDef) => void;
}) {
  const { t } = useTranslation("workflows");
  const table = tables.find((tb) => tb.id === step.tableId);
  const replace = (next: DataStep) => onChange({ ...def, steps: def.steps.map((s) => (s.id === step.id ? next : s)) });
  const wire = (target: DataTarget) => (source: Source | null) => {
    // A name that can't be a value yet keeps the last one that could.
    if (source) onChange(setSource(def, step.id, target, source));
  };

  return (
    <>
      <FormField label={t("dataPanel.actionLabel")} htmlFor="data-action">
        <select
          id="data-action"
          value={step.action}
          onChange={(e) => replace(resetStep(step, e.target.value as DataStep["action"], step.tableId))}
          className={selectClass}
        >
          {ACTIONS.map((action) => (
            <option key={action} value={action}>
              {t(`dataPanel.action.${action}`)}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label={t("dataPanel.table")} htmlFor="data-table">
        {tableList.length === 0 && step.tableId === "" ? (
          <p className="text-[13px] text-faint">
            <Trans t={t} i18nKey="dataPanel.noTable" components={[<Link key="data" to="/settings/data" className="text-accent underline-offset-2 hover:underline" />]} />
          </p>
        ) : (
          <select id="data-table" value={step.tableId} onChange={(e) => replace(resetStep(step, step.action, e.target.value))} className={selectClass}>
            <option value="" disabled>
              {t("dataPanel.chooseTable")}
            </option>
            {tableList.map((tb) => (
              <option key={tb.id} value={tb.id}>
                {tb.name}
              </option>
            ))}
          </select>
        )}
      </FormField>

      {table && step.action === "update-row" && (
        <SourcePicker
          // Another table starts the row over: so does the picker.
          key={step.tableId}
          label={t("dataPanel.row")}
          def={def}
          stepId={step.id}
          expected={expected}
          source={step.rowId}
          allowValue
          defaultName="row_id"
          onChange={wire("rowId")}
        />
      )}

      {table && step.action !== "find-rows" && (
        <>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-muted">{t("dataPanel.fields")}</p>
            <ul className="space-y-1.5">
              {table.fields.map((f) => {
                const checked = step.inputs.some((i) => i.fieldId === f.id);
                const files = f.type === "attachment";
                const Icon = FIELD_TYPE_UI[f.type].Icon;
                return (
                  <li key={f.id}>
                    <label className="flex items-center gap-2 text-[14px] has-disabled:text-faint">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={files}
                        onChange={() => {
                          const selected = table.fields.filter((g) => (g.id === f.id ? !checked : step.inputs.some((i) => i.fieldId === g.id)));
                          onChange(setDataFields(def, step.id, table, selected.map((g) => g.id)));
                        }}
                        className="size-4 accent-[var(--accent)]"
                      />
                      <Icon size={14} className="text-faint" aria-hidden />
                      {f.name}
                    </label>
                    {files && <p className="ml-6 text-[12px] text-faint">{t("dataPanel.noFiles")}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
          {step.inputs.map((input) => {
            const field = table.fields.find((f) => f.id === input.fieldId);
            if (!field) return null;
            return (
              <SourcePicker
                key={input.fieldId}
                label={field.name}
                def={def}
                stepId={step.id}
                expected={expected}
                source={input.source}
                allowValue
                field={field}
                defaultName={slugify(field.name)}
                onChange={wire({ fieldId: input.fieldId })}
              />
            );
          })}
        </>
      )}

      {table && step.action === "find-rows" && (
        <Filters step={step} table={table} def={def} expected={expected} onChange={onChange} replace={replace} />
      )}

      <div>
        <p className="mb-1.5 text-[13px] font-medium text-muted">{t("dataPanel.gives")}</p>
        <ul aria-label={t("dataPanel.gives")} className="divide-y divide-line overflow-hidden rounded-xl ring-1 ring-line">
          {DATA_OUTPUTS[step.action].map((name) => (
            <li key={name} className="px-3 py-2 font-mono text-[13px]">{`{{${step.key}.${name}}}`}</li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** find-rows: its filters (all must hold) and how many rows it gives at most. */
function Filters({
  step,
  table,
  def,
  expected,
  onChange,
  replace,
}: {
  step: Extract<DataStep, { action: "find-rows" }>;
  table: TableSchema;
  def: WorkflowDef;
  expected: Record<string, OutputField[]>;
  onChange: (def: WorkflowDef) => void;
  replace: (step: DataStep) => void;
}) {
  const { t } = useTranslation("workflows");
  const setFilters = (filters: DataFilter[]) => replace({ ...step, filters });
  /** The filter on `fieldId` with `op`, keeping its value only when the op still takes one. */
  const filterOf = (fieldId: string, op: FilterOp, value?: Source): DataFilter =>
    takesValue(op) ? { fieldId, op, value: value ?? { type: "value", value: "" } } : { fieldId, op };

  return (
    <>
      <div className="space-y-3">
        <p className="text-[13px] font-medium text-muted">{t("dataPanel.rowsWhere")}</p>
        {step.filters.map((filter, i) => {
          const field = table.fields.find((f) => f.id === filter.fieldId);
          const ops: readonly FilterOp[] = field ? FILTER_OPS[field.type] : [];
          return (
            <fieldset key={`${i}-${filter.fieldId}`} aria-label={t("dataPanel.filterN", { n: i + 1 })} className="space-y-2 rounded-xl p-3 ring-1 ring-line">
              <div className="flex items-center gap-2">
                <select
                  aria-label={t("dataPanel.field")}
                  value={field ? filter.fieldId : ""}
                  onChange={(e) => {
                    const next = table.fields.find((f) => f.id === e.target.value)!;
                    setFilters(step.filters.map((f, j) => (j === i ? filterOf(next.id, FILTER_OPS[next.type][0]) : f)));
                  }}
                  className={selectClass}
                >
                  {!field && (
                    <option value="" disabled>
                      {t("dataPanel.deletedField")}
                    </option>
                  )}
                  {table.fields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("dataPanel.removeFilter", { n: i + 1 })}
                  onClick={() => setFilters(step.filters.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
              {field && (
                <select
                  aria-label={t("dataPanel.operator")}
                  value={filter.op}
                  onChange={(e) => setFilters(step.filters.map((f, j) => (j === i ? filterOf(f.fieldId, e.target.value as FilterOp, f.value) : f)))}
                  className={selectClass}
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>
                      {t(`dataPanel.filterOp.${op}`)}
                    </option>
                  ))}
                </select>
              )}
              {field && filter.value && (
                <SourcePicker
                  def={def}
                  stepId={step.id}
                  expected={expected}
                  source={filter.value}
                  allowValue
                  field={filter.op === "contains" || filter.op === "not-contains" ? { ...field, type: "text" } : field}
                  defaultName={slugify(field.name)}
                  onChange={(source) => source && onChange(setSource(def, step.id, { filter: i }, source))}
                />
              )}
            </fieldset>
          );
        })}
        {step.filters.length < 20 && table.fields.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const first = table.fields[0]!;
              setFilters([...step.filters, filterOf(first.id, FILTER_OPS[first.type][0])]);
            }}
          >
            <Plus /> {t("dataPanel.addFilter")}
          </Button>
        )}
        {step.filters.length === 0 && <p className="text-[13px] text-faint">{t("dataPanel.noFilter")}</p>}
      </div>
      <FormField label={t("dataPanel.atMost")} htmlFor="data-limit" hint={t("dataPanel.limitHint")}>
        <Input
          id="data-limit"
          type="number"
          min={1}
          max={100}
          value={step.limit}
          onChange={(e) => {
            const limit = Math.round(Number(e.target.value));
            if (limit >= 1 && limit <= 100) replace({ ...step, limit });
          }}
        />
      </FormField>
    </>
  );
}
