import type { Cell, FieldSchema } from "@dispand/domain/data/fields";
import type { RowQuery } from "@dispand/domain/data/query";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ColumnDef, flexRender, type RowSelectionState, rowSelectionFeature, tableFeatures, useTable } from "@tanstack/react-table";
import { Maximize2, Plus, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, orpc } from "../../lib/api.ts";
import { type GridKey, type GridPos, nextCell } from "../../lib/grid-keys.ts";
import { useTableWatch } from "../../lib/table-watch.ts";
import { AttachmentCell } from "./AttachmentCell.tsx";
import { CellEditor, type CommitMove } from "./CellEditor.tsx";
import { CellView } from "./CellView.tsx";
import { FieldMenu } from "./FieldMenu.tsx";
import { FIELD_TYPE_UI } from "./field-types.ts";
import { NewFieldPopover } from "./NewFieldPopover.tsx";
import { addListRow, patchListRows, rowWrites, setListCell } from "./row-writes.ts";
import { ViewBar } from "./ViewBar.tsx";

const PAGE = 100;

type Page = Awaited<ReturnType<typeof api.rows.list>>;
type Row = Page["rows"][number];

const MOVES: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"]);
/** Types whose editor is a text box, so typing a character starts editing with it. */
const TYPED: ReadonlySet<FieldSchema["type"]> = new Set(["text", "long-text", "number", "url", "date"]);
/** The only table feature the grid uses: the server sorts, filters and pages the rows. */
const features = tableFeatures({ rowSelectionFeature });


const same = (a: Cell | undefined, b: Cell) => JSON.stringify(a ?? null) === JSON.stringify(b);
/** The id of the new row shown before it exists. */
const DRAFT = "draft";
/** A new row: the values saved in it, and its id once the server has created it. */
type NewRow = { id: string | null; values: Record<string, Cell> };

/**
 * The table's rows, editable in place. Rows load 100 at a time ("Load more"). A cell edit is
 * shown at once and sent as one `rows.update` of that cell; when it fails the cell goes back and
 * the reason shows above the grid.
 */
type Props = {
  tableId: string;
  fields: FieldSchema[];
  onSchemaChanged: () => void;
  /** Sort and filter, from the URL. */
  query: RowQuery;
  onQueryChange: (query: RowQuery) => void;
  onOpenRow: (rowId: string) => void;
  /** The table's required parent field: a new row is created with its parent, picked first. */
  requiredParent?: FieldSchema;
};

export function Grid({ tableId, fields, onSchemaChanged, query, onQueryChange, onOpenRow, requiredParent }: Props) {
  const [pickingParent, setPickingParent] = useState(false);
  const queryClient = useQueryClient();
  const listKey = orpc.rows.list.key({ input: { tableId } });
  const rowsQuery = useInfiniteQuery(
    orpc.rows.list.infiniteOptions({
      input: (offset: number) => ({ tableId, query, offset, limit: PAGE }),
      initialPageParam: 0,
      getNextPageParam: (last, all) => {
        const loaded = all.reduce((n, p) => n + p.rows.length, 0);
        return loaded < last.total ? loaded : undefined;
      },
    }),
  );
  const rows = useMemo(() => rowsQuery.data?.pages.flatMap((p) => p.rows) ?? [], [rowsQuery.data]);
  const total = rowsQuery.data?.pages.at(-1)?.total ?? 0;
  const files = useMemo(() => Object.assign({}, ...(rowsQuery.data?.pages.map((p) => p.attachments) ?? [])) as Page["attachments"], [rowsQuery.data]);
  const references = useMemo(() => Object.assign({}, ...(rowsQuery.data?.pages.map((p) => p.references) ?? [])) as Page["references"], [rowsQuery.data]);
  const filtered = query.filters.length > 0;
  // Every row, for "N of M rows" while a filter hides some.
  const all = useQuery({ ...orpc.rows.list.queryOptions({ input: { tableId, limit: 1 } }), enabled: filtered });

  const [active, setActive] = useState<GridPos | null>(null);
  const [editing, setEditing] = useState<{ initialText?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  // "New row" adds a draft at the end, on the client only. The row is created with the first
  // value saved in it, so a trigger on `created` gets that value, never an empty row; values
  // saved before the server answers wait behind the creation in the queue of row writes.
  const [draft, setDraft] = useState<{ row: NewRow; sent: boolean } | null>(null);
  // The latest new row keeps its React key once created, so an editor open on it stays.
  const latest = useRef<NewRow | null>(null);
  const keyOf = (r: Row) => (r.id === DRAFT || r.id === latest.current?.id ? "new" : r.id);
  const shown = useMemo(() => (draft ? [...rows, { id: DRAFT, tableId, values: draft.row.values } as Row] : rows), [rows, draft, tableId]);

  // Changes made elsewhere (another tab, a workflow) reach the grid, but never while the owner is on
  // a cell: rows don't move under the cursor. What came meanwhile is read once the cell is left.
  const [stale, setStale] = useState(false);
  const busy = active !== null || editing !== null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: listKey });
    void queryClient.invalidateQueries({ queryKey: orpc.tables.get.key({ input: { id: tableId } }) });
  };
  useTableWatch(tableId, () => (busy ? setStale(true) : refresh()));
  useEffect(() => {
    if (!busy && stale) {
      setStale(false);
      refresh();
    }
  }, [busy, stale]);

  const patchRows = (change: (rows: Row[], last: boolean) => Row[], totalBy = 0) => patchListRows(queryClient, tableId, change, totalBy);
  const setCell = (rowId: string, fieldId: string, value: Cell, unless?: (current: Cell | undefined) => boolean) =>
    setListCell(queryClient, tableId, rowId, fieldId, value, unless);

  // Every row write of this table runs in one queue (`rowWrites`), in the order the owner made
  // them, so a later edit always reaches the server last. Each response touches only the cell it
  // saved, so it never undoes a newer edit shown meanwhile.
  const update = useMutation({
    ...rowWrites(tableId),
    // A new row's edit carries it (`row`) and what the cell held before: its creation is queued
    // ahead of the edit, so its id is known by the time the edit runs.
    mutationFn: (input: { id: string; fieldId: string; value: Cell; row?: NewRow; before?: Cell }) => {
      const id = input.row ? input.row.id : input.id;
      if (!id) throw new Error("the row wasn't added");
      return api.rows.update({ id, values: { [input.fieldId]: input.value } });
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const before = input.row ? (input.before ?? null) : (rows.find((r) => r.id === input.id)?.values[input.fieldId] ?? null);
      setCell(input.id, input.fieldId, input.value);
      return { before };
    },
    onError: (err, input, ctx) => {
      // Back to what it was, unless a newer edit of this cell replaced it meanwhile.
      setCell(input.row?.id ?? input.id, input.fieldId, ctx?.before ?? null, (current) => !same(current, input.value));
      const field = fields.find((f) => f.id === input.fieldId);
      setError(`Could not save “${field?.name ?? "the cell"}”: ${err.message}`);
    },
    onSuccess: (row, input) => {
      setError(null);
      setCell(row.id, input.fieldId, (row.values[input.fieldId] ?? null) as Cell, (current) => !same(current, input.value));
      // The row stays where it is, even when the edit changes its place under the sort or takes it
      // out of the filter: rows never move under the owner's cursor (docs/ARCHITECTURE.md).
    },
  });

  const create = useMutation({
    ...rowWrites(tableId),
    mutationFn: async (input: { row: NewRow; values: Record<string, Cell> }) => {
      const row = await api.rows.create({ tableId, values: input.values });
      input.row.id = row.id;
      return row;
    },
    // A list read already on its way could bring the new row back next to the draft. A first
    // load (of another sort or filter) is left alone: there is no list to show the row in without it.
    onMutate: () => queryClient.cancelQueries({ queryKey: listKey, predicate: (q) => q.state.data !== undefined }),
    onSuccess: (row, input) => {
      setError(null);
      // Shown at the end of the loaded rows, where the draft was, with the values saved in the
      // draft meanwhile (their updates follow); a reload puts it in its place in the order.
      addListRow(queryClient, tableId, row, input.row.values);
      setDraft((d) => (d?.row === input.row ? null : d));
    },
    onError: (err, input) => {
      setDraft((d) => (d?.row === input.row ? null : d));
      setError(`Could not add a row: ${err.message}`);
    },
  });

  const remove = useMutation({
    ...rowWrites(tableId),
    mutationFn: (ids: string[]) => api.rows.delete({ ids }),
    onSuccess: (_, ids) => {
      setSelection({});
      setConfirmDelete(false);
      setActive(null);
      const gone = new Set(ids);
      patchRows((list) => list.filter((r) => !gone.has(r.id)), -ids.length);
    },
    onError: (err) => setError(`Could not delete the rows: ${err.message}`),
  });

  const columns = useMemo<ColumnDef<typeof features, Row>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all rows"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
            className="size-4 accent-[var(--accent)]"
          />
        ),
        cell: ({ row }) => (
          <span className="flex items-center gap-1">
            <input type="checkbox" aria-label="Select row" checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} className="size-4 accent-[var(--accent)]" />
            <button type="button" aria-label="Open row" onClick={() => onOpenRow(row.original.id)} className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
              <Maximize2 size={13} aria-hidden />
            </button>
          </span>
        ),
      },
      ...fields.map(
        (field): ColumnDef<typeof features, Row> => ({
          id: field.id,
          accessorFn: (r) => r.values[field.id] ?? null,
        }),
      ),
    ],
    [fields, onOpenRow],
  );

  const table = useTable({
    features,
    data: shown,
    columns,
    getRowId: (r) => r.id,
    state: { rowSelection: selection },
    onRowSelectionChange: setSelection,
    enableRowSelection: true,
  });

  // Only rows shown can be deleted: a row selected, then hidden by a filter, is left alone.
  const selectedIds = rows.filter((r) => selection[r.id]).map((r) => r.id);

  /**
   * Adds a draft row after the loaded rows (so "New row" waits for the first page: rows arriving
   * later would move it); with `values` (a parent picked first), the row is created with them at once.
   */
  const newRow = (values: Record<string, Cell> = {}) => {
    const row: NewRow = { id: null, values };
    latest.current = row;
    const sent = Object.keys(values).length > 0;
    setDraft({ row, sent });
    if (sent) create.mutate({ row, values });
    setActive({ row: rows.length, col: 0 });
    setEditing({});
  };

  const commit = (pos: GridPos, value: Cell) => {
    const row = shown[pos.row];
    const field = fields[pos.col];
    if (!row || !field || same(row.values[field.id], value)) return;
    if (row.id === DRAFT && draft) {
      const before = draft.row.values[field.id] ?? null;
      draft.row.values = { ...draft.row.values, [field.id]: value };
      setDraft({ row: draft.row, sent: true });
      if (draft.sent) update.mutate({ id: DRAFT, fieldId: field.id, value, row: draft.row, before });
      else create.mutate({ row: draft.row, values: draft.row.values });
      return;
    }
    update.mutate({ id: row.id, fieldId: field.id, value });
  };

  // A draft left before anything was saved in it goes away: no row is created.
  useEffect(() => {
    if (draft && !draft.sent && active?.row !== rows.length) setDraft(null);
  }, [active, draft, rows.length]);

  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });

  const endEdit = (value: Cell | undefined, move?: CommitMove) => {
    if (active && value !== undefined) commit(active, value);
    setEditing(null);
    if (active && move) setActive(nextCell(active, move, { rows: shown.length, cols: fields.length }));
    focusGrid();
  };

  const startEdit = (pos: GridPos, initialText?: string) => {
    const field = fields[pos.col];
    const row = shown[pos.row];
    if (!field || !row) return;
    if (field.type === "checkbox") return commit(pos, row.values[field.id] !== true);
    if (field.type === "attachment") return row.id === DRAFT ? undefined : onOpenRow(row.id);
    setEditing({ initialText });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !active || e.target !== e.currentTarget) return;
    const key = e.key === "Tab" && e.shiftKey ? "ShiftTab" : e.key;
    if (MOVES.has(e.key)) {
      e.preventDefault();
      setActive(nextCell(active, key as GridKey, { rows: shown.length, cols: fields.length }));
    } else if (e.key === "Enter" || (e.key === " " && fields[active.col]?.type === "checkbox")) {
      e.preventDefault();
      startEdit(active);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (fields[active.col]?.type !== "attachment") commit(active, null);
    } else if (e.key === "Escape") {
      setActive(null);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && TYPED.has(fields[active.col]!.type)) {
      e.preventDefault();
      startEdit(active, e.key);
    }
  };

  // Keeps the active cell in view as the keyboard moves it.
  useEffect(() => {
    if (!active) return;
    gridRef.current?.querySelector(`[data-cell="${active.row}:${active.col}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div className="grid gap-3">
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <ViewBar fields={fields} query={query} onChange={onQueryChange} shown={total} total={filtered ? (all.data?.total ?? total) : total} />
        {selectedIds.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete {selectedIds.length === 1 ? "1 row" : `${selectedIds.length} rows`}
          </Button>
        )}
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label="Rows"
        aria-rowcount={total + (draft ? 2 : 1)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="overflow-auto rounded-2xl bg-surface shadow-card outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-[14px]">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header, i) => {
                  const field = fields[i - 1];
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={cn(
                        "h-10 border-b border-line bg-surface px-2 text-left font-medium text-muted",
                        i === 0 && "sticky left-0 z-10 w-[4.5rem]",
                        i === 1 && "sticky left-[4.5rem] z-10 border-r",
                      )}
                    >
                      {field ? (
                        <div className="flex w-48 items-center gap-1.5">
                          {(() => {
                            const { Icon } = FIELD_TYPE_UI[field.type];
                            return <Icon size={14} aria-label={FIELD_TYPE_UI[field.type].label} className="shrink-0" />;
                          })()}
                          <span className="truncate text-fg">{field.name}</span>
                          <span className="ml-auto" />
                          <FieldMenu field={field} fields={fields} tableId={tableId} onChanged={onSchemaChanged} />
                        </div>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
                <th scope="col" className="h-10 w-12 border-b border-line bg-surface px-2">
                  <NewFieldPopover tableId={tableId} onCreated={onSchemaChanged} />
                </th>
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, r) => (
              <tr key={keyOf(row.original)} className="group">
                {row.getAllCells().map((cell, i) => {
                  if (i === 0) {
                    return (
                      <td key={cell.column.id} className="sticky left-0 z-[5] h-10 w-[4.5rem] border-b border-line bg-surface px-2 group-hover:bg-hover">
                        {row.id !== DRAFT && flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  }
                  const c = i - 1;
                  const field = fields[c]!;
                  const isActive = active?.row === r && active.col === c;
                  const value = (row.original.values[field.id] ?? null) as Cell;
                  return (
                    <td
                      key={cell.column.id}
                      role="gridcell"
                      data-cell={`${r}:${c}`}
                      aria-label={field.name}
                      aria-selected={isActive}
                      onClick={(e) => {
                        // A click inside the open editor (caret, text, a choice) stays there.
                        if (e.target instanceof Element && e.target.closest("input, textarea, [role=listbox], button")) return;
                        if (isActive && !editing) startEdit({ row: r, col: c });
                        else if (field.type === "checkbox") commit({ row: r, col: c }, value !== true);
                        setActive({ row: r, col: c });
                        if (!isActive) setEditing(null);
                        focusGrid();
                      }}
                      onDoubleClick={() => startEdit({ row: r, col: c })}
                      className={cn(
                        "relative h-10 max-w-60 border-b border-line bg-surface px-2 group-hover:bg-hover",
                        c === 0 && "sticky left-[4.5rem] z-[5] border-r",
                        isActive && "outline-2 -outline-offset-2 outline-accent",
                      )}
                    >
                      <div className="w-48 truncate">
                        {field.type === "attachment" && Array.isArray(value) ? <AttachmentCell ids={value} files={files} /> : <CellView field={field} value={value} references={references} />}
                      </div>
                      {isActive && editing && (
                        <CellEditor
                          key={`${keyOf(row.original)}:${field.id}`}
                          field={field}
                          value={value}
                          initialText={editing.initialText}
                          onCommit={(v, move) => endEdit(v, move)}
                          onCancel={() => endEdit(undefined)}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="h-10 border-b border-line bg-surface group-hover:bg-hover" />
              </tr>
            ))}
          </tbody>
        </table>
        {rowsQuery.isPending && <p className="px-4 py-3 text-[13px] text-muted">Loading…</p>}
        {rowsQuery.error && <p role="alert" className="px-4 py-3 text-[13px] text-danger">Could not load the rows.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {requiredParent ? (
          // Every row belongs to a parent: it is picked before the row exists.
          <Popover open={pickingParent} onOpenChange={setPickingParent}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" disabled={create.isPending || rowsQuery.isPending}>
                <Plus /> New row
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <p className="mb-2 text-[13px] text-muted">Which {requiredParent.name} does it belong to?</p>
              <CellEditor
                field={requiredParent}
                value={null}
                inline={false}
                onCommit={(value) => {
                  if (value === null) return;
                  setPickingParent(false);
                  newRow({ [requiredParent.id]: value });
                }}
                onCancel={() => setPickingParent(false)}
              />
            </PopoverContent>
          </Popover>
        ) : (
          <Button variant="ghost" size="sm" disabled={create.isPending || rowsQuery.isPending} onClick={() => newRow()}>
            <Plus /> New row
          </Button>
        )}
        {rowsQuery.hasNextPage && (
          <Button variant="outline" size="sm" disabled={rowsQuery.isFetchingNextPage} onClick={() => void rowsQuery.fetchNextPage()}>
            Load more
          </Button>
        )}
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogTitle>Delete {selectedIds.length === 1 ? "1 row" : `${selectedIds.length} rows`}?</DialogTitle>
          <DialogDescription>This can't be undone.</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(selectedIds)}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
