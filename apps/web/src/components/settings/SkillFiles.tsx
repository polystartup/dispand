import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export type SkillFileRow = { path: string; size: number; overridden: "changed" | "added" | null };

/**
 * The files of a plugin's skill: each can be edited or removed, which makes it its owner's, and an
 * owner's change (a changed, added or removed file) can be taken back to the plugin's.
 */
export function SkillFiles({ files, removed, busy, onEdit, onRemove, onReset }: { files: SkillFileRow[]; removed: string[]; busy: boolean; onEdit: (path: string) => void; onRemove: (path: string) => void; onReset: (path: string) => void }) {
  const { t } = useTranslation("skills");
  const reset = (path: string) => (
    <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t("files.resetLabel", { path })} onClick={() => onReset(path)}>
      {t("files.reset")}
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
            {f.overridden && <span className="block text-muted">{t(`files.yours.${f.overridden}`)}</span>}
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t("files.editLabel", { path: f.path })} onClick={() => onEdit(f.path)}>
            {t("files.edit")}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t("files.removeLabel", { path: f.path })} onClick={() => onRemove(f.path)}>
            {t("files.remove")}
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
            <span className="block text-muted">{t("files.removed")}</span>
          </span>
          {reset(path)}
        </li>
      ))}
    </ul>
  );
}
