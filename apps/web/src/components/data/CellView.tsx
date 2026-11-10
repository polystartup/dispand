import type { Cell, FieldSchema } from "@dispand/domain/data/fields";
import { Check } from "lucide-react";

/** A cell as the grid shows it, read-only. */
export function CellView({ field, value }: { field: FieldSchema; value: Cell }) {
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  switch (field.type) {
    case "checkbox":
      return value === true ? <Check size={16} aria-label="Checked" className="text-accent" /> : null;
    case "number":
      return <span className="block text-right tabular-nums">{String(value)}</span>;
    case "url":
      return (
        <a href={String(value)} target="_blank" rel="noreferrer noopener" className="text-accent underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );
    case "single-select": {
      const label = field.choices.find((c) => c.id === value)?.label;
      return label ? <span className="rounded-full bg-hover px-2 py-0.5 text-[13px]">{label}</span> : null;
    }
    case "attachment": {
      const n = Array.isArray(value) ? value.length : 0;
      return <span className="text-muted">{n === 1 ? "1 file" : `${n} files`}</span>;
    }
    case "long-text":
      return <span>{String(value).split("\n")[0]}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}
