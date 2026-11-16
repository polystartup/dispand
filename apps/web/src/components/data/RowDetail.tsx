import { type Cell, cellText, type FieldSchema } from "@dispand/domain/data/fields";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import { AttachmentEditor } from "./AttachmentCell.tsx";
import { CellEditor } from "./CellEditor.tsx";
import { useFormat } from "../../lib/format.ts";
import { FIELD_TYPE_UI, useFieldTypeLabel } from "./field-types.ts";
import { listCell, patchListRows, rowWrites, sameCell, setListCell } from "./row-writes.ts";

/**
 * One row in a side panel (`?row=<id>`): every field in order, each saved when it is left, its
 * times, and Delete. The title is the primary field. Escape closes it.
 */
export function RowDetail({ tableId, rowId, fields, onClose }: { tableId: string; rowId: string; fields: FieldSchema[]; onClose: () => void }) {
  const { t } = useTranslation(["data", "common"]);
  const format = useFormat();
  const typeLabel = useFieldTypeLabel();
  const time = (date: Date) => format.dateTime(date, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" });
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The first read of the row runs in the table's queue of row writes, after every write made
  // before the panel opened (a grid edit still saving): the editors never start from an older
  // copy. Later reads (after this panel's own writes) are plain queries.
  const [ready, setReady] = useState(false);
  const getKey = orpc.rows.get.queryKey({ input: { id: rowId } });
  const first = useMutation({ ...rowWrites(tableId), mutationFn: () => api.rows.get({ id: rowId }) });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    first.mutateAsync().then(
      (data) => {
        queryClient.setQueryData(getKey, data);
        setReady(true);
      },
      () => {},
    );
  }, [first, getKey, queryClient]);
  const row = useQuery({ ...orpc.rows.get.queryOptions({ input: { id: rowId } }), enabled: ready });

  // This panel's row is read again; the grid's list never is: each save patches its own cell in
  // the cached pages, as the grid's edits do (`row-writes.ts`), and new files join their views.
  const refresh = async () => {
    await queryClient.refetchQueries({ queryKey: orpc.rows.get.key({ input: { id: rowId } }) });
    const fresh = queryClient.getQueryData<Awaited<ReturnType<typeof api.rows.get>>>(getKey);
    if (fresh) patchListRows(queryClient, tableId, (list) => list, 0, fresh.attachments);
  };
  // In the table's queue of row writes, with the grid's, so they reach the server in order.
  const update = useMutation({
    ...rowWrites(tableId),
    mutationFn: (input: { fieldId: string; value: Cell }) => api.rows.update({ id: rowId, values: { [input.fieldId]: input.value } }),
    onMutate: (input) => {
      const before = listCell(queryClient, tableId, rowId, input.fieldId);
      setListCell(queryClient, tableId, rowId, input.fieldId, input.value);
      return { before };
    },
    onError: (_err, input, ctx) => setListCell(queryClient, tableId, rowId, input.fieldId, ctx?.before ?? null, (current) => !sameCell(current, input.value)),
    onSuccess: (saved, input) => setListCell(queryClient, tableId, rowId, input.fieldId, saved.values[input.fieldId] ?? null, (current) => !sameCell(current, input.value)),
  });
  // Every commit is a change the owner made (the editors send only those), so each one is queued.
  const save = async (field: FieldSchema, value: Cell) => {
    try {
      await update.mutateAsync({ fieldId: field.id, value });
      setError(null);
    } catch (err) {
      setError(t("row.saveFailed", { name: field.name, message: err instanceof Error ? err.message : t("row.tryAgain") }));
      throw err;
    } finally {
      await refresh();
    }
  };
  const remove = useMutation({
    ...rowWrites(tableId),
    mutationFn: () => api.rows.delete({ ids: [rowId] }),
    onSuccess: () => {
      onClose();
      patchListRows(queryClient, tableId, (list) => list.filter((r) => r.id !== rowId), -1);
    },
  });

  const primary = fields[0];
  const title = (primary && row.data && cellText(primary, row.data.values[primary.id] ?? null)) || t("row.untitled");

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <div className="border-b border-line px-6 py-5 pr-12">
          <SheetTitle className="truncate text-[20px] font-semibold">{title}</SheetTitle>
          <SheetDescription className="mt-1 text-[12px] text-muted">
            {row.data ? t("row.dates", { created: time(row.data.createdAt), updated: time(row.data.updatedAt) }) : t("common:loading")}
          </SheetDescription>
        </div>
        {(first.error ?? row.error) && <p role="alert" className="px-6 py-4 text-[14px] text-danger">{t("row.gone")}</p>}
        {row.data && ready && (
          <div className="grid gap-5 px-6 py-5">
            {error && (
              <p role="alert" className="text-[13px] text-danger">
                {error}
              </p>
            )}
            {fields.map((field) => {
              const { Icon } = FIELD_TYPE_UI[field.type];
              const value = (row.data.values[field.id] ?? null) as Cell;
              return (
                <section key={field.id} aria-label={field.name} className="grid gap-1.5">
                  <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
                    <Icon size={13} aria-label={typeLabel(field.type)} /> {field.name}
                  </h3>
                  {field.type === "attachment" ? (
                    <AttachmentEditor
                      label={field.name}
                      tableId={tableId}
                      rowId={rowId}
                      fieldId={field.id}
                      ids={Array.isArray(value) ? value : []}
                      files={row.data.attachments}
                      onSaved={refresh}
                    />
                  ) : (
                    <CellEditor
                      key={`${rowId}:${field.id}`}
                      field={field}
                      value={value}
                      inline={false}
                      onCommit={(v) => void save(field, v).catch(() => {})}
                      onCancel={() => {}}
                    />
                  )}
                </section>
              );
            })}
            <div className="border-t border-line pt-4">
              {confirmDelete ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px]">{t("row.confirm")}</span>
                  <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                    {t("row.delete")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    {t("row.cancel")}
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> {t("row.delete")}
                </Button>
              )}
              {remove.error && <p role="alert" className="mt-2 text-[13px] text-danger">{remove.error.message}</p>}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
