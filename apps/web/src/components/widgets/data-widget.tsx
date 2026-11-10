import type { FieldSchema } from "@dispand/domain/data/fields";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { orpc } from "../../lib/api.ts";
import { useTableWatch } from "../../lib/table-watch.ts";
import { AttachmentCell } from "../data/AttachmentCell.tsx";
import { CellView } from "../data/CellView.tsx";
import { WidgetHeader } from "./WidgetHeader.tsx";
import type { Widget } from "./WorkflowFormWidget.tsx";

export type DataWidget = Extract<Widget, { type: "grid" | "table" }>;
type Files = Parameters<typeof AttachmentCell>[0]["files"];

/**
 * The widget's table and the fields it shows (those deleted since it was set up are skipped),
 * kept current: every change of the table, from this tab or another, refreshes both.
 */
export function useDataWidget(widget: DataWidget) {
  const { tableId } = widget;
  const queryClient = useQueryClient();
  useTableWatch(tableId, () => {
    void queryClient.invalidateQueries({ queryKey: orpc.rows.list.key({ input: { tableId } }) });
    void queryClient.invalidateQueries({ queryKey: orpc.tables.get.key({ input: { id: tableId } }) });
  });
  const table = useQuery({
    ...orpc.tables.get.queryOptions({ input: { id: tableId } }),
    // A table that doesn't exist won't by retrying.
    retry: (failures, error) => (error as { code?: string }).code !== "NOT_FOUND" && failures < 3,
  });
  const all = table.data?.fields ?? [];
  const shown = widget.config.fieldIds.flatMap((id) => all.find((f) => f.id === id) ?? []);
  return { table, shown, all };
}

/** What a data widget shows instead of its rows while it has none to show. */
export function DataWidgetFrame({ widget, editing, extra, notice, children }: { widget: DataWidget; editing: boolean; extra?: ReactNode; notice?: string; children?: ReactNode }) {
  return (
    <section aria-label={widget.title} className="flex h-full flex-col overflow-hidden rounded-2xl bg-surface shadow-card">
      <WidgetHeader widget={widget} editing={editing} extra={extra} />
      {notice ? (
        <p role="status" className="px-5 pb-5 text-[14px] text-muted">
          {notice}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

/** Why the widget has no rows to show yet, or null once it has a table and fields. */
export function dataNotice(table: { error: unknown; data?: unknown }, shown: FieldSchema[]): string | null {
  if (table.error && !table.data) return (table.error as { code?: string }).code === "NOT_FOUND" ? "This table no longer exists." : "Could not load this table.";
  if (!table.data) return "Loading…";
  if (shown.length === 0) return "The fields this widget showed were deleted. Choose others from its settings in Edit mode.";
  return null;
}

/** A cell as the widgets show it: the files of a files cell as thumbnails, the rest read-only. */
export function WidgetCell({ field, value, files }: { field: FieldSchema; value: Parameters<typeof CellView>[0]["value"]; files: Files }) {
  if (field.type === "attachment") return Array.isArray(value) && value.length > 0 ? <AttachmentCell ids={value} files={files} /> : null;
  return <CellView field={field} value={value} />;
}

/** "Showing 100 of N · Open in Data". */
export function OpenInData({ tableId, shown, total }: { tableId: string; shown: number; total: number }) {
  return (
    <p className="px-5 py-2 text-[13px] text-muted">
      {shown < total ? `Showing ${shown} of ${total} · ` : ""}
      <Link to="/settings/data/$tableId" params={{ tableId }} className="text-accent hover:underline">
        Open in Data
      </Link>
    </p>
  );
}
