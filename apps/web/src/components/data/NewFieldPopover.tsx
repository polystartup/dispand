import { FIELD_TYPES, type FieldType } from "@dispand/domain/data/fields";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { orpc } from "../../lib/api.ts";
import { FIELD_TYPE_UI } from "./field-types.ts";

/** One choice per line, with an id made here (the server keeps the ids it is given). */
export function choicesFromLines(text: string) {
  const labels = [...new Set(text.split("\n").map((l) => l.trim()).filter(Boolean))];
  return labels.map((label) => ({ id: `c_${crypto.randomUUID().slice(0, 12)}`, label }));
}

export const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-2 text-[14px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** The "+" header of the grid: name, type, and choices for a single select. */
export function NewFieldPopover({ tableId, onCreated }: { tableId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [choices, setChoices] = useState("");
  const [target, setTarget] = useState("");
  const tables = useQuery({ ...orpc.tables.list.queryOptions(), enabled: open && type === "reference" });
  const create = useMutation(
    orpc.fields.create.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setName("");
        setType("text");
        setChoices("");
        setTarget("");
        onCreated();
      },
    }),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ tableId, name: name.trim(), type, choices: type === "single-select" ? choicesFromLines(choices) : [], ...(type === "reference" ? { referencesTableId: target } : {}) });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) create.reset();
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label="Add a field" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-hover">
          <Plus size={16} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <form onSubmit={submit} className="grid gap-3">
          <label className="grid gap-1 text-[13px] font-medium text-muted">
            Field name
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
          </label>
          <label className="grid gap-1 text-[13px] font-medium text-muted">
            Type
            <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className={selectClass}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_UI[t].label}
                </option>
              ))}
            </select>
          </label>
          {type === "single-select" && (
            <label className="grid gap-1 text-[13px] font-medium text-muted">
              Choices, one per line
              <textarea value={choices} onChange={(e) => setChoices(e.target.value)} rows={4} className="rounded-md border border-input bg-transparent px-3 py-2 text-[14px] outline-none" />
            </label>
          )}
          {type === "reference" && (
            <label className="grid gap-1 text-[13px] font-medium text-muted">
              Rows of
              <select value={target} onChange={(e) => setTarget(e.target.value)} className={selectClass} required>
                <option value="">Choose a table</option>
                {(tables.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {create.error && <p role="alert" className="text-[13px] text-danger">{create.error.message}</p>}
          <Button type="submit" disabled={create.isPending || name.trim() === "" || (type === "reference" && target === "")}>
            Add field
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
