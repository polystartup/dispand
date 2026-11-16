import { FIELD_TYPES, type FieldSchema, type FieldType } from "@dispand/domain/data/fields";
import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { orpc } from "../../lib/api.ts";
import { useFieldTypeLabel } from "./field-types.ts";
import { selectClass } from "./NewFieldPopover.tsx";

/** What a retype does to the cells, said before it runs. */
export function retypeSummary(t: TFunction<"data">, { converted, cleared }: { converted: number; cleared: number }): string {
  if (converted === 0 && cleared === 0) return t("retype.none");
  if (cleared === 0) return t("retype.converted", { count: converted });
  return t("retype.convertedCleared", { count: converted, cleared });
}

/**
 * Changes a field's type. The owner first sees, from a dry run, how many values convert and how
 * many would be cleared; nothing changes until they confirm.
 */
export function RetypeDialog({ field, open, onOpenChange, onDone }: { field: FieldSchema; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const { t } = useTranslation("data");
  const typeLabel = useFieldTypeLabel();
  const [type, setType] = useState<FieldType | "">("");
  const check = useMutation(orpc.fields.retype.mutationOptions());
  const apply = useMutation(
    orpc.fields.retype.mutationOptions({
      onSuccess: () => {
        close();
        onDone();
      },
    }),
  );

  const choose = (next: FieldType | "") => {
    setType(next);
    apply.reset();
    if (next) check.mutate({ id: field.id, type: next, dryRun: true });
    else check.reset();
  };
  // Every way out forgets the preview: the cells may change before the dialog opens again.
  const close = () => {
    choose("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent>
        <DialogTitle>{t("retype.title", { name: field.name })}</DialogTitle>
        <DialogDescription>{t("retype.description")}</DialogDescription>
        <label className="grid gap-1 text-[13px] font-medium text-muted">
          {t("retype.newType")}
          <select value={type} onChange={(e) => choose(e.target.value as FieldType | "")} className={selectClass}>
            <option value="">{t("retype.choose")}</option>
            {FIELD_TYPES.filter((ft) => (ft !== field.type || ft === "single-select") && ft !== "reference").map((ft) => (
              <option key={ft} value={ft}>
                {typeLabel(ft)}
              </option>
            ))}
          </select>
        </label>
        {check.data && type && <p role="status" className="text-[14px]">{retypeSummary(t, check.data)}</p>}
        {(check.error ?? apply.error) && <p role="alert" className="text-[13px] text-danger">{(check.error ?? apply.error)!.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t("retype.cancel")}
          </Button>
          <Button disabled={!type || !check.data || check.isPending || apply.isPending} onClick={() => type && apply.mutate({ id: field.id, type, dryRun: false })}>
            {t("retype.submit")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
