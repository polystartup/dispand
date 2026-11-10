import { FIELD_TYPES, type FieldSchema, type FieldType } from "@dispand/domain/data/fields";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { orpc } from "../../lib/api.ts";
import { FIELD_TYPE_UI } from "./field-types.ts";
import { selectClass } from "./NewFieldPopover.tsx";

const values = (n: number) => (n === 1 ? "1 value" : `${n} values`);

/** What a retype does to the cells, said before it runs. */
export function retypeSummary({ converted, cleared }: { converted: number; cleared: number }): string {
  if (converted === 0 && cleared === 0) return "No value to convert.";
  if (cleared === 0) return `${values(converted)} will be converted.`;
  return `${values(converted)} will be converted, ${cleared} can't be and will be cleared.`;
}

/**
 * Changes a field's type. The owner first sees, from a dry run, how many values convert and how
 * many would be cleared; nothing changes until they confirm.
 */
export function RetypeDialog({ field, open, onOpenChange, onDone }: { field: FieldSchema; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
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
        <DialogTitle>Change the type of “{field.name}”</DialogTitle>
        <DialogDescription>Values that fit the new type are converted; the others are cleared.</DialogDescription>
        <label className="grid gap-1 text-[13px] font-medium text-muted">
          New type
          <select value={type} onChange={(e) => choose(e.target.value as FieldType | "")} className={selectClass}>
            <option value="">Choose a type</option>
            {FIELD_TYPES.filter((t) => t !== field.type || t === "single-select").map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_UI[t].label}
              </option>
            ))}
          </select>
        </label>
        {check.data && type && <p role="status" className="text-[14px]">{retypeSummary(check.data)}</p>}
        {(check.error ?? apply.error) && <p role="alert" className="text-[13px] text-danger">{(check.error ?? apply.error)!.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!type || !check.data || check.isPending || apply.isPending} onClick={() => type && apply.mutate({ id: field.id, type, dryRun: false })}>
            Change type
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
