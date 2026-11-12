import type { Cell, FieldSchema } from "@dispand/domain/data/fields";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CellEditor } from "./CellEditor.tsx";
import { FIELD_TYPE_UI } from "./field-types.ts";

type Props = {
  fields: FieldSchema[];
  /** The table's required parent field: "Create row" waits for it. */
  requiredParent?: FieldSchema;
  onCreate: (values: Record<string, Cell>) => void;
  onCancel: () => void;
  pending: boolean;
  /** Why the last creation failed. */
  error?: string;
};

/**
 * "New row": the table's fields in a form, and the row is created with them in one `rows.create`
 * when it is saved. The grid never shows a row the server doesn't have, and cancelling creates
 * nothing. Files are added from the row detail once the row exists.
 */
export function NewRowDialog({ fields, requiredParent, onCreate, onCancel, pending, error }: Props) {
  const [values, setValues] = useState<Record<string, Cell>>({});
  // Read by "Create row": a field left by clicking the button commits during that same click.
  const latest = useRef(values);
  const [problem, setProblem] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const editable = fields.filter((f) => f.type !== "attachment");

  const set = (field: FieldSchema, value: Cell) => {
    latest.current = { ...latest.current, [field.id]: value };
    setValues(latest.current);
    setProblem(null);
  };
  const create = () => {
    // A text that doesn't fit its field stays in its box with the reason, and isn't created empty.
    if (formRef.current?.querySelector('[aria-invalid="true"]')) return setProblem("Fix the fields marked above first.");
    const filled = Object.fromEntries(Object.entries(latest.current).filter(([, v]) => v !== null));
    // A table of files only has nothing to fill here: its row is created empty, and filled in its detail.
    if (Object.keys(filled).length === 0 && editable.length > 0) return setProblem("Fill in at least one field.");
    onCreate(filled);
  };

  return (
    // A creation under way finishes in this form: it can't be closed and opened again meanwhile.
    <Dialog open onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>New row</DialogTitle>
        <DialogDescription>The row is created when you click Create row. Files are added from the row once it exists.</DialogDescription>
        <div ref={formRef} className="grid gap-4">
          {editable.map((field) => {
            const { Icon, label } = FIELD_TYPE_UI[field.type];
            return (
              <section key={field.id} aria-label={field.name} className="grid gap-1.5">
                <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
                  <Icon size={13} aria-label={label} /> {field.name}
                  {field.id === requiredParent?.id && <span className="text-faint">(required)</span>}
                </h3>
                <CellEditor field={field} value={values[field.id] ?? null} inline={false} onCommit={(v) => set(field, v)} onCancel={() => {}} />
              </section>
            );
          })}
        </div>
        {(problem ?? error) && (
          <p role="alert" className="text-[13px] text-danger">
            {problem ?? error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={pending || (requiredParent !== undefined && values[requiredParent.id] == null)} onClick={create}>
            Create row
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
