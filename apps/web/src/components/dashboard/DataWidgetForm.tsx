import type { FieldType } from "@dispand/domain/data/fields";
import type { Sort } from "@dispand/domain/data/query";
import { MAX_WIDGET_FIELDS } from "@dispand/domain/pages/config";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";

type Kind = "grid" | "table";
export type DataWidgetConfig = { fieldIds: string[]; coverFieldId?: string; sort?: Sort };
export type DataWidgetValues = { tableId: string; config: DataWidgetConfig };
type Props = {
  kind: Kind;
  /** Set when editing a widget: its table can't change. */
  initial?: DataWidgetValues;
  submitLabel: string;
  pending: boolean;
  error?: string;
  onSubmit: (values: DataWidgetValues) => void;
};

/** Its table, the fields a Grid or Table widget shows (in the table's order), and a cover (Grid) or the default sort (Table). */
export function DataWidgetForm({ kind, initial, submitLabel, pending, error, onSubmit }: Props) {
  const tables = useQuery(orpc.tables.list.queryOptions());
  const [tableId, setTableId] = useState(initial?.tableId ?? "");
  const [chosen, setChosen] = useState<string[] | null>(initial?.config.fieldIds ?? null);
  const [cover, setCover] = useState(initial?.config.coverFieldId ?? "");
  const [sortField, setSortField] = useState(initial?.config.sort?.fieldId ?? "");
  const [dir, setDir] = useState<"asc" | "desc">(initial?.config.sort?.dir ?? "asc");
  const table = useQuery({ ...orpc.tables.get.queryOptions({ input: { id: tableId } }), enabled: tableId !== "" });
  const fields = table.data?.fields ?? [];
  // Until the owner chooses, the table's first fields.
  const ids = new Set(chosen ?? fields.slice(0, 4).map((f) => f.id));
  const withType = (types: (t: FieldType) => boolean) => fields.filter((f) => types(f.type));

  const toggle = (id: string) => {
    const next = new Set(ids);
    if (!next.delete(id)) next.add(id);
    setChosen(fields.filter((f) => next.has(f.id)).map((f) => f.id));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fieldIds = fields.filter((f) => ids.has(f.id)).map((f) => f.id);
    onSubmit({
      tableId,
      config: {
        fieldIds,
        ...(kind === "grid" && cover && { coverFieldId: cover }),
        ...(kind === "table" && sortField && { sort: { fieldId: sortField, dir } }),
      },
    });
  };
  const count = [...ids].filter((id) => fields.some((f) => f.id === id)).length;

  return (
    <form onSubmit={submit} className="grid gap-4">
      <label className="grid gap-1 text-[14px]">
        Table
        <select
          value={tableId}
          disabled={initial !== undefined}
          onChange={(e) => {
            setTableId(e.target.value);
            setChosen(null);
            setCover("");
            setSortField("");
          }}
          className={selectClass}
        >
          <option value="" disabled>
            Choose a table
          </option>
          {tables.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {tableId && !table.data && <p className="text-[13px] text-muted">{table.error ? "Could not load this table." : "Loading…"}</p>}
      {table.data && (
        <>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-[14px]">
              Fields <span className="text-muted">({kind === "grid" ? "the first is the card's title" : "the columns"})</span>
            </legend>
            {fields.map((f) => (
              <label key={f.id} className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={ids.has(f.id)}
                  disabled={!ids.has(f.id) && count >= MAX_WIDGET_FIELDS}
                  onChange={() => toggle(f.id)}
                  className="size-4 accent-[var(--accent)]"
                />
                {f.name}
              </label>
            ))}
          </fieldset>
          {kind === "grid" ? (
            <label className="grid gap-1 text-[14px]">
              Cover
              <select value={cover} onChange={(e) => setCover(e.target.value)} className={selectClass}>
                <option value="">No cover</option>
                {withType((t) => t === "attachment").map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <label className="grid gap-1 text-[14px]">
                Sort by
                <select value={sortField} onChange={(e) => setSortField(e.target.value)} className={selectClass}>
                  <option value="">Creation order</option>
                  {withType((t) => t !== "attachment").map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <select aria-label="Direction" value={dir} disabled={!sortField} onChange={(e) => setDir(e.target.value as "asc" | "desc")} className={selectClass}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending || !table.data || count === 0}>
        {submitLabel}
      </Button>
    </form>
  );
}
