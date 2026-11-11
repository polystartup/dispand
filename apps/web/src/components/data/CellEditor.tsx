import { type Cell, cellText, type FieldSchema, parseCellText } from "@dispand/domain/data/fields";
import { Check } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { orpc } from "../../lib/api.ts";

/** How the grid moves after a commit made from the keyboard. */
export type CommitMove = "Tab" | "ShiftTab" | "Enter";

type Props = {
  field: FieldSchema;
  value: Cell;
  onCommit: (value: Cell, move?: CommitMove) => void;
  onCancel: () => void;
  /** In the grid, the editor sits over the cell; in the row detail it is a plain form control. */
  inline?: boolean;
  /** Replaces the cell's text when editing starts by typing a character. */
  initialText?: string;
};

const inputClass = "w-full rounded-md border border-accent bg-surface px-2 py-1 text-[14px] outline-none";

/**
 * Edits one cell. Text is parsed with the field's rules (`parseCellText`): a value that doesn't
 * fit shows why and isn't committed. Escape cancels. Checkboxes toggle at once in the grid and
 * attachments open the row detail, so neither has an editor here.
 */
export function CellEditor({ field, value, onCommit, onCancel, inline = true, initialText }: Props) {
  if (field.type === "single-select") return <SelectEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} inline={inline} />;
  if (field.type === "reference") return <ReferenceEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} inline={inline} />;
  if (field.type === "checkbox") {
    return (
      <input type="checkbox" aria-label={field.name} checked={value === true} onChange={(e) => onCommit(e.target.checked)} className="size-4 accent-[var(--accent)]" />
    );
  }
  if (field.type === "attachment") return null;
  return <TextEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} inline={inline} initialText={initialText} />;
}

function TextEditor({ field, value, onCommit, onCancel, inline, initialText }: Props) {
  const [text, setText] = useState(() => initialText ?? cellText(field, value));
  const [problem, setProblem] = useState<string | null>(null);
  const long = field.type === "long-text";
  // Set once the editor committed or cancelled, so the blur that follows doesn't do it again.
  const done = useRef(false);
  // In the row detail, only a value the owner changed is saved: the editor never sends back
  // what it was given, so it can't overwrite a newer value with an older one.
  const edited = useRef(initialText !== undefined);

  const commit = (move?: CommitMove) => {
    if (!inline && !edited.current) return;
    const parsed = parseCellText(field, text);
    if (!parsed.ok) {
      setProblem(parsed.reason);
      return;
    }
    done.current = true;
    edited.current = false;
    onCommit(parsed.value, move);
  };
  const cancel = () => {
    done.current = true;
    onCancel();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // In the grid, Escape only leaves the cell; in the row detail it also closes the panel.
      if (inline) {
        e.preventDefault();
        e.stopPropagation();
      }
      cancel();
    } else if (e.key === "Enter" && (!long || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(long ? undefined : "Enter");
    } else if (e.key === "Tab" && inline) {
      // In the grid, Tab moves to the next cell; in the row detail it moves focus as usual.
      e.preventDefault();
      commit(e.shiftKey ? "ShiftTab" : "Tab");
    }
  };

  const common = {
    "aria-label": field.name,
    "aria-invalid": problem !== null,
    // Focused with the caret after the text, so typing to start editing goes on from the first key.
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!el || !inline || el === document.activeElement) return;
      el.focus();
      if (field.type !== "date") el.setSelectionRange(el.value.length, el.value.length);
    },
    value: text,
    onKeyDown,
    // Leaving the field keeps what fits. In the grid what doesn't fit is dropped; in the row
    // detail it stays, with its reason, until it is fixed.
    onBlur: () => {
      if (done.current) return;
      const parsed = parseCellText(field, text);
      if (parsed.ok) commit();
      else if (inline) cancel();
      else setProblem(parsed.reason);
    },
    onChange: (e: { target: { value: string } }) => {
      done.current = false;
      edited.current = true;
      setText(e.target.value);
      setProblem(null);
    },
  };
  return (
    <div className={cn(inline && "absolute left-0 top-0 z-20 min-w-full", long && inline && "w-80")}>
      {long ? (
        <textarea {...common} rows={6} className={cn(inputClass, "resize-y")} />
      ) : (
        <input {...common} type={field.type === "date" ? "date" : field.type === "url" ? "url" : "text"} inputMode={field.type === "number" ? "decimal" : undefined} className={inputClass} />
      )}
      {long && <p className="mt-1 text-[12px] text-faint">⌘/Ctrl + Enter to save</p>}
      {problem && (
        <p role="alert" className="mt-1 rounded-md bg-surface px-2 py-1 text-[12px] text-danger shadow-card">
          {problem}
        </p>
      )}
    </div>
  );
}

/** A reference: one of the rows of its table, named by their first field (the first 100). */
function ReferenceEditor({ field, ...rest }: Props) {
  const tableId = field.referencesTableId ?? "";
  const table = useQuery(orpc.tables.get.queryOptions({ input: { id: tableId } }));
  const rows = useQuery(orpc.rows.list.queryOptions({ input: { tableId, limit: 100 } }));
  const first = table.data?.fields.find((f) => f.position === 0);
  const choices = (rows.data?.rows ?? []).map((r) => {
    const value = first ? r.values[first.id] : null;
    const label = first && value !== null && value !== undefined ? cellText(first, value) : "";
    return { id: r.id, label: label || "Untitled row" };
  });
  return <SelectEditor field={{ ...field, choices }} {...rest} />;
}

function SelectEditor({ field, value, onCommit, onCancel, inline }: Props) {
  return (
    <div
      className={cn("rounded-xl bg-surface p-1", inline ? "absolute left-0 top-0 z-20 min-w-48 shadow-card" : "border border-line")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && inline) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <ul role="listbox" aria-label={field.name}>
        {field.choices.map((c, i) => (
          <li
            key={c.id}
            role="option"
            aria-selected={c.id === value}
            tabIndex={0}
            // `autoFocus` does nothing on an <li>: focus it here, so the keyboard reaches the list.
            ref={(el) => {
              if (el && inline && (c.id === value || (value === null && i === 0)) && !el.parentElement?.contains(document.activeElement)) el.focus();
            }}
            onClick={() => onCommit(c.id)}
            onKeyDown={(e) => e.key === "Enter" && onCommit(c.id)}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[14px] outline-none hover:bg-hover focus:bg-hover"
          >
            {c.label}
            {c.id === value && <Check size={14} aria-hidden />}
          </li>
        ))}
      </ul>
      {field.choices.length === 0 && (
        <p className="px-2 py-1.5 text-[13px] text-muted">{field.type === "reference" ? "No rows in that table yet." : "No choices yet: add them from the field's menu."}</p>
      )}
      <button type="button" onClick={() => onCommit(null)} className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-muted hover:bg-hover">
        Clear
      </button>
    </div>
  );
}
