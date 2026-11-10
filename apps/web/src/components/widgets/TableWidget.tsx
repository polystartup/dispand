import type { Sort } from "@dispand/domain/data/query";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";
import { DataWidgetSettings } from "../dashboard/DataWidgetSettings.tsx";
import { type DataWidget, DataWidgetFrame, dataNotice, OpenInData, useDataWidget, WidgetCell } from "./data-widget.tsx";

const PAGE = 50;

/** A read-only table of the chosen fields. Header clicks sort for this viewer only: ascending, descending, then the widget's own order. */
export function TableWidget({ widget, editing }: { widget: Extract<DataWidget, { type: "table" }>; editing: boolean }) {
  const { table, shown, all } = useDataWidget(widget);
  const { tableId } = widget;
  const navigate = useNavigate();
  const [viewSort, setViewSort] = useState<Sort | undefined>();
  // A sort on a field deleted since is dropped, like a deleted column.
  const sortable = (s: Sort | undefined) => (s && all.some((f) => f.id === s.fieldId && f.type !== "attachment") ? s : undefined);
  const sort = sortable(viewSort) ?? sortable(widget.config.sort);
  const rows = useInfiniteQuery({
    ...orpc.rows.list.infiniteOptions({
      input: (offset: number) => ({ tableId, query: { filters: [], sort: sort ? [sort] : [] }, offset, limit: PAGE }),
      initialPageParam: 0,
      getNextPageParam: (last, pages) => {
        const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
        return loaded < last.total ? loaded : undefined;
      },
    }),
    enabled: shown.length > 0 && table.data !== undefined,
  });
  const loaded = rows.data?.pages.flatMap((p) => p.rows) ?? [];
  const files = Object.assign({}, ...(rows.data?.pages.map((p) => p.attachments) ?? [])) as NonNullable<typeof rows.data>["pages"][number]["attachments"];
  const total = rows.data?.pages.at(-1)?.total ?? 0;
  const notice = dataNotice(table, shown);

  const cycle = (fieldId: string) =>
    setViewSort((current) => (current?.fieldId !== fieldId ? { fieldId, dir: "asc" } : current.dir === "asc" ? { fieldId, dir: "desc" } : undefined));
  const open = (rowId: string) => void navigate({ to: "/settings/data/$tableId", params: { tableId }, search: { row: rowId } });

  return (
    <DataWidgetFrame widget={widget} editing={editing} extra={<DataWidgetSettings widget={widget} />} notice={notice ?? undefined}>
      {rows.error && !rows.data ? (
        <p role="alert" className="px-5 pb-5 text-[14px] text-muted">
          Could not load the rows.
        </p>
      ) : !rows.data ? (
        <p className="px-5 pb-5 text-[14px] text-faint">Loading…</p>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto px-2">
            <table className="w-max min-w-full border-separate border-spacing-0 text-[14px]">
              <thead>
                <tr>
                  {shown.map((field) => {
                    const dir = sort?.fieldId === field.id ? sort.dir : undefined;
                    return (
                      <th key={field.id} scope="col" aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined} className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-left font-medium text-muted">
                        {field.type === "attachment" ? (
                          field.name
                        ) : (
                          <button type="button" onClick={() => cycle(field.id)} className="inline-flex items-center gap-1 hover:text-fg">
                            {field.name}
                            {dir === "asc" && <ArrowUp size={13} aria-hidden />}
                            {dir === "desc" && <ArrowDown size={13} aria-hidden />}
                          </button>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {loaded.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => open(row.id)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(row.id)}
                    className="cursor-pointer outline-none hover:bg-hover focus-visible:bg-hover"
                  >
                    {shown.map((field) => (
                      <td key={field.id} className="max-w-64 truncate border-b border-line px-3 py-2">
                        <WidgetCell field={field} value={row.values[field.id] ?? null} files={files} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {loaded.length === 0 && <p className="px-3 py-2 text-[14px] text-muted">No rows yet.</p>}
          </div>
          {rows.hasNextPage && (
            <div className="px-5 pt-2">
              <Button variant="outline" size="sm" disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
          <OpenInData tableId={tableId} shown={loaded.length} total={total} />
        </>
      )}
    </DataWidgetFrame>
  );
}
