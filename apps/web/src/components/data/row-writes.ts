import type { Cell } from "@dispand/domain/data/fields";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";

// A table's row writes and the grid's cached pages.
//
// The queue: TanStack Query runs the mutations of one scope one after the other, so every write
// (grid edits, new and deleted rows, the row detail's saves and file changes, and the detail's
// first read) reaches the server in the order it was made.
//
// The cache: no write re-asks the list. Each one patches only its own cell in the cached pages,
// so rows never reorder under the grid's cursor and a keyboard edit can't land on another row.

export const rowWrites = (tableId: string) => ({ scope: { id: `rows:${tableId}` } });

type Page = Awaited<ReturnType<typeof api.rows.list>>;
export type ListRow = Page["rows"][number];
export type Pages = InfiniteData<Page, number>;

/** Applies `change` to the rows of every cached page of the table, `totalBy` to its total, and adds `files` to its files. */
export function patchListRows(
  queryClient: QueryClient,
  tableId: string,
  change: (rows: ListRow[], last: boolean) => ListRow[],
  totalBy = 0,
  files: Page["attachments"] = {},
) {
  queryClient.setQueriesData<Pages>({ queryKey: orpc.rows.list.key({ input: { tableId } }) }, (data) =>
    data?.pages
      ? {
          ...data,
          pages: data.pages.map((p, i) => ({ ...p, rows: change(p.rows, i === data.pages.length - 1), total: p.total + totalBy, attachments: { ...p.attachments, ...files } })),
        }
      : data,
  );
}

/**
 * Puts a row just created at the end of each cached list, with `values` over its own. A list read
 * since the creation may hold it already: that list only takes `values`, keeping its newer cells.
 */
export function addListRow(queryClient: QueryClient, tableId: string, row: ListRow, values: Record<string, Cell>) {
  queryClient.setQueriesData<Pages>({ queryKey: orpc.rows.list.key({ input: { tableId } }) }, (data) => {
    if (!data?.pages) return data;
    const listed = data.pages.some((p) => p.rows.some((r) => r.id === row.id));
    const pages = data.pages.map((p, i) =>
      listed
        ? { ...p, rows: p.rows.map((r) => (r.id === row.id ? { ...r, values: { ...r.values, ...values } } : r)) }
        : { ...p, rows: i === data.pages.length - 1 ? [...p.rows, { ...row, values: { ...row.values, ...values } }] : p.rows, total: p.total + 1 },
    );
    return { ...data, pages };
  });
}

/** Sets one cell of a cached row (the row's other cells stay), unless `unless` says the cell already moved on. */
export function setListCell(queryClient: QueryClient, tableId: string, rowId: string, fieldId: string, value: Cell, unless?: (current: Cell | undefined) => boolean) {
  patchListRows(queryClient, tableId, (list) => list.map((r) => (r.id === rowId && !unless?.(r.values[fieldId]) ? { ...r, values: { ...r.values, [fieldId]: value } } : r)));
}

export const sameCell = (a: Cell | undefined, b: Cell) => JSON.stringify(a ?? null) === JSON.stringify(b);

/** A cell as the cached pages hold it (null when the row isn't loaded). */
export function listCell(queryClient: QueryClient, tableId: string, rowId: string, fieldId: string): Cell {
  for (const [, data] of queryClient.getQueriesData<Pages>({ queryKey: orpc.rows.list.key({ input: { tableId } }) })) {
    const row = data?.pages?.flatMap((p) => p.rows).find((r) => r.id === rowId);
    if (row) return row.values[fieldId] ?? null;
  }
  return null;
}
