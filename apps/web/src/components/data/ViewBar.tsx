import type { FieldSchema } from "@dispand/domain/data/fields";
import { FILTER_OPS, type Filter, type FilterOp, queryProblem, type RowQuery, type Sort, takesValue } from "@dispand/domain/data/query";
import { ArrowUpDown, ListFilter, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { selectClass } from "./NewFieldPopover.tsx";

const MAX_FILTERS = 20;
const MAX_SORTS = 3;

const OP_LABELS: Record<FilterOp, string> = {
  contains: "contains",
  "not-contains": "doesn't contain",
  is: "is",
  "is-not": "is not",
  empty: "is empty",
  "not-empty": "is not empty",
  "=": "=",
  "!=": "≠",
  "<": "<",
  "<=": "≤",
  ">": ">",
  ">=": "≥",
  checked: "is checked",
  unchecked: "is not checked",
  before: "is before",
  after: "is after",
};

const opsOf = (field: FieldSchema) => FILTER_OPS[field.type] as readonly FilterOp[];
/** A filter the server can run: the rest stay in the popover until they are complete. */
const complete = (filter: Filter, fields: FieldSchema[]) => queryProblem({ filters: [filter], sort: [] }, fields) === null;

/**
 * Sort (up to 3 fields) and filter (up to 20 conditions, all of which must match) of the grid,
 * and how many rows match. The query lives in the URL: `onChange` puts it there.
 */
export function ViewBar({ fields, query, onChange, shown, total }: { fields: FieldSchema[]; query: RowQuery; onChange: (query: RowQuery) => void; shown: number; total: number }) {
  // Filters being written stay here; only complete ones reach the URL and the server.
  const [drafts, setDrafts] = useState<Filter[]>(query.filters);
  const sortable = fields.filter((f) => f.type !== "attachment");

  const setFilters = (next: Filter[]) => {
    setDrafts(next);
    onChange({ ...query, filters: next.filter((f) => complete(f, fields)) });
  };
  const setSort = (sort: Sort[]) => onChange({ ...query, sort });

  const filtered = query.filters.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* On open, the URL's filters (they may have changed: back button, a link) and the drafts still being written. */}
      <Popover onOpenChange={(open) => open && setDrafts([...query.filters, ...drafts.filter((f) => !complete(f, fields))])}>
        <PopoverTrigger asChild>
          <Button variant={filtered ? "secondary" : "ghost"} size="sm">
            <ListFilter /> {filtered ? `Filter (${query.filters.length})` : "Filter"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[34rem]">
          <div className="grid gap-2" role="group" aria-label="Filters">
            {drafts.length === 0 && <p className="text-[13px] text-muted">No filter: every row shows.</p>}
            {drafts.map((filter, i) => {
              const field = fields.find((f) => f.id === filter.fieldId) ?? fields[0]!;
              const update = (change: Partial<Filter>) => setFilters(drafts.map((f, j) => (j === i ? { ...f, ...change } : f)));
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <select
                    aria-label="Filter field"
                    value={field.id}
                    onChange={(e) => {
                      const next = fields.find((f) => f.id === e.target.value)!;
                      update({ fieldId: next.id, op: opsOf(next)[0]!, value: "" });
                    }}
                    className={selectClass}
                  >
                    {fields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Filter condition" value={filter.op} onChange={(e) => update({ op: e.target.value as FilterOp })} className={selectClass}>
                    {opsOf(field).map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </select>
                  {takesValue(filter.op) ? <ValueInput field={field} value={filter.value ?? ""} onChange={(value) => update({ value })} /> : <span className="w-full" />}
                  <Button variant="ghost" size="icon-sm" aria-label="Remove filter" onClick={() => setFilters(drafts.filter((_, j) => j !== i))}>
                    <X />
                  </Button>
                </div>
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              disabled={drafts.length >= MAX_FILTERS || fields.length === 0}
              onClick={() => setFilters([...drafts, { fieldId: fields[0]!.id, op: opsOf(fields[0]!)[0]!, value: "" }])}
            >
              <Plus /> Add filter
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant={query.sort.length > 0 ? "secondary" : "ghost"} size="sm">
            <ArrowUpDown /> {query.sort.length > 0 ? `Sort (${query.sort.length})` : "Sort"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-96">
          <div className="grid gap-2" role="group" aria-label="Sort">
            {query.sort.length === 0 && <p className="text-[13px] text-muted">Rows show in the order they were added.</p>}
            {query.sort.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  aria-label="Sort field"
                  value={s.fieldId}
                  onChange={(e) => setSort(query.sort.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))}
                  className={selectClass}
                >
                  {sortable.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Sort direction"
                  value={s.dir}
                  onChange={(e) => setSort(query.sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as Sort["dir"] } : x)))}
                  className={selectClass}
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
                <Button variant="ghost" size="icon-sm" aria-label="Remove sort" onClick={() => setSort(query.sort.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              disabled={query.sort.length >= MAX_SORTS || sortable.length === 0}
              onClick={() => setSort([...query.sort, { fieldId: sortable.find((f) => !query.sort.some((s) => s.fieldId === f.id))?.id ?? sortable[0]!.id, dir: "asc" }])}
            >
              <Plus /> Add sort
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <span className="text-[13px] text-muted" role="status">
        {filtered ? `${shown} of ${total} ${total === 1 ? "row" : "rows"}` : `${total} ${total === 1 ? "row" : "rows"}`}
      </span>
    </div>
  );
}

/** The value of a condition, by the field's type. A single select compares with a choice's label. */
function ValueInput({ field, value, onChange }: { field: FieldSchema; value: string; onChange: (value: string) => void }) {
  if (field.type === "single-select") {
    return (
      <select aria-label="Filter value" value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">Choose</option>
        {field.choices.map((c) => (
          <option key={c.id} value={c.label}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      aria-label="Filter value"
      type={field.type === "date" ? "date" : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={10_000}
    />
  );
}
