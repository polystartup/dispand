import type { AttachmentView } from "@dispand/domain";
import { CELL_LIMITS } from "@dispand/domain/data/fields";
import { FileText, Upload, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { api } from "../../lib/api.ts";
import { rowWrites, setListCell } from "./row-writes.ts";

export const fileUrl = (id: string) => `/files/${encodeURIComponent(id)}`;

/** One file: a thumbnail for an image sniffed on upload, a chip with its name otherwise. */
function FileItem({ id, file, size }: { id: string; file?: AttachmentView; size: "sm" | "lg" }) {
  if (file?.image) {
    return <img src={fileUrl(id)} alt={file.name} className={cn("rounded-md border border-line object-cover", size === "sm" ? "size-7" : "size-20")} />;
  }
  return (
    <a
      href={fileUrl(id)}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex max-w-40 items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 text-[12px] text-fg"
      title={file?.name}
    >
      <FileText size={12} aria-hidden className="shrink-0" />
      <span className="truncate">{file?.name ?? "File"}</span>
    </a>
  );
}

/** The files of a cell in the grid, read-only. */
export function AttachmentCell({ ids, files }: { ids: string[]; files: Record<string, AttachmentView> }) {
  return (
    <span className="flex items-center gap-1 overflow-hidden" aria-label={`${ids.length} ${ids.length === 1 ? "file" : "files"}`}>
      {ids.map((id) => (
        <FileItem key={id} id={id} file={files[id]} size="sm" />
      ))}
    </span>
  );
}

/**
 * The files of a cell in the row detail: remove buttons, and a drop zone and picker that upload
 * each file (`files.upload`). Each change ("add these", "remove that") runs in the table's queue
 * of row writes and the server applies it to the cell as stored (`rows.editFiles`), never to a
 * list read earlier: an upload that lands after the panel was closed or reopened, or from another
 * tab, is never undone.
 */
export function AttachmentEditor({
  label,
  tableId,
  rowId,
  fieldId,
  ids,
  files,
  onSaved,
}: {
  label: string;
  tableId: string;
  rowId: string;
  fieldId: string;
  ids: string[];
  files: Record<string, AttachmentView>;
  onSaved: () => Promise<unknown>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const queryClient = useQueryClient();
  const edit = useMutation({
    ...rowWrites(tableId),
    // Applied by the server to the cell as stored (`rows.editFiles`), so a change from another tab
    // is never dropped either.
    mutationFn: (op: { add: string[] } | { remove: string }) =>
      api.rows.editFiles({ id: rowId, fieldId, add: "add" in op ? op.add : [], remove: "remove" in op ? [op.remove] : [] }),
    // Files cells are changed only here (the grid opens this panel for them), so the saved list is
    // put in the grid's cached row as it is.
    onSuccess: (saved) => setListCell(queryClient, tableId, rowId, fieldId, saved.values[fieldId] ?? null),
    onError: (err) => setError(err.message),
    onSettled: () => onSaved(),
  });
  const busy = uploading || edit.isPending;

  const upload = async (picked: File[]) => {
    if (picked.length === 0 || busy) return;
    if (ids.length + picked.length > CELL_LIMITS.attachments) {
      setError(`A cell holds at most ${CELL_LIMITS.attachments} files.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const added: string[] = [];
      for (const file of picked) added.push((await api.files.upload({ tableId, file })).id);
      edit.mutate({ add: added });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the file.");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void upload([...e.dataTransfer.files]);
  };

  return (
    <div className="grid gap-2">
      {ids.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={`${label} files`}>
          {ids.map((id) => (
            <li key={id} className="relative flex items-center">
              <FileItem id={id} file={files[id]} size="lg" />
              <button
                type="button"
                aria-label={`Remove ${files[id]?.name ?? "file"}`}
                disabled={busy}
                onClick={() => {
                  setError(null);
                  edit.mutate({ remove: id });
                }}
                className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full bg-surface text-muted shadow-card hover:text-fg"
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn("grid place-items-center rounded-xl border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted", over && "border-accent bg-hover")}
      >
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-1.5 font-medium text-accent disabled:opacity-50">
          <Upload size={14} aria-hidden /> {busy ? "Uploading…" : "Add files"}
        </button>
        <span>or drop them here (10 MiB each)</span>
        <input ref={input} type="file" multiple hidden aria-label={`Upload to ${label}`} onChange={(e) => void upload([...(e.target.files ?? [])])} />
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
