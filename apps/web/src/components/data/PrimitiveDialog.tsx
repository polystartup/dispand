import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { orpc } from "../../lib/api.ts";
import { selectClass } from "./NewFieldPopover.tsx";
import { qualifiedName } from "@dispand/domain/plugins/names";

type Table = { id: string; name: string; primitive: boolean; parent: { tableId: string; required: boolean } | null };

/**
 * Whether a table's row changes are events (a primitive table), and its parent: another table
 * each row belongs to, through a reference field (made when the table has none).
 */
export function PrimitiveDialog({ table, open, onOpenChange, onSaved }: { table: Table; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation("data");
  const [primitive, setPrimitive] = useState(table.primitive);
  const [parentId, setParentId] = useState(table.parent?.tableId ?? "");
  const [required, setRequired] = useState(table.parent?.required ?? false);
  const tables = useQuery({ ...orpc.tables.list.queryOptions(), enabled: open });
  const save = useMutation(
    orpc.tables.setPrimitive.mutationOptions({
      onSuccess: () => {
        onSaved();
        onOpenChange(false);
      },
    }),
  );
  const submit = () => save.mutate({ id: table.id, primitive, parent: primitive && parentId ? { tableId: parentId, required } : null });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{t("primitive.title")}</DialogTitle>
        <DialogDescription>{t("primitive.description")}</DialogDescription>
        <label className="flex items-start gap-2 text-[14px]">
          <input type="checkbox" checked={primitive} onChange={(e) => setPrimitive(e.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" />
          <span>
            {t("primitive.events")}
            <span className="block text-[12px] text-muted">{t("primitive.eventsHint")}</span>
          </span>
        </label>
        {primitive && (
          <>
            <label className="grid gap-1 text-[13px] font-medium text-muted">
              {t("primitive.parent")}
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={selectClass}>
                <option value="">{t("primitive.noParent")}</option>
                {(tables.data ?? [])
                  .filter((tb) => tb.id !== table.id)
                  .map((tb) => (
                    <option key={tb.id} value={tb.id}>
                      {qualifiedName(tb.plugin?.name ?? null, tb.name)}
                    </option>
                  ))}
              </select>
            </label>
            {parentId && (
              <label className="flex items-center gap-2 text-[14px]">
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                {t("primitive.required")}
              </label>
            )}
          </>
        )}
        {save.error && (
          <p role="alert" className="text-[13px] text-danger">
            {save.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("primitive.cancel")}
          </Button>
          <Button disabled={save.isPending} onClick={submit}>
            {t("primitive.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
