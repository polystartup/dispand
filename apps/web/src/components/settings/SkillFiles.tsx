import { Button } from "@/components/ui/button";

export type SkillFileRow = { path: string; size: number; overridden: "changed" | "added" | null };

/**
 * The files of a plugin's skill: each can be edited or removed, which makes it its owner's, and an
 * owner's change (a changed, added or removed file) can be taken back to the plugin's.
 */
export function SkillFiles({ files, removed, busy, onEdit, onRemove, onReset }: { files: SkillFileRow[]; removed: string[]; busy: boolean; onEdit: (path: string) => void; onRemove: (path: string) => void; onReset: (path: string) => void }) {
  const reset = (path: string) => (
    <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Reset ${path} to the plugin's`} onClick={() => onReset(path)}>
      Reset
    </Button>
  );
  return (
    <ul className="divide-y divide-border text-[13px]">
      {files.map((f) => (
        <li key={f.path} className="flex items-center gap-2 py-2">
          <span className="min-w-0 flex-1">
            <span data-path className="block truncate font-mono">
              {f.path}
            </span>
            {f.overridden && <span className="block text-muted">Yours: {f.overridden}</span>}
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Edit ${f.path}`} onClick={() => onEdit(f.path)}>
            Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${f.path}`} onClick={() => onRemove(f.path)}>
            Remove
          </Button>
          {f.overridden && reset(f.path)}
        </li>
      ))}
      {removed.map((path) => (
        <li key={path} className="flex items-center gap-2 py-2">
          <span className="min-w-0 flex-1">
            <span data-path className="block truncate font-mono text-faint line-through">
              {path}
            </span>
            <span className="block text-muted">Removed by you</span>
          </span>
          {reset(path)}
        </li>
      ))}
    </ul>
  );
}
