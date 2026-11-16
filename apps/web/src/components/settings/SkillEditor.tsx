import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { FormField } from "./parts.tsx";

export type SkillPackage = Awaited<ReturnType<typeof api.skills.list>>[number];

/** The package caps (`validatePackage`), checked here too so a too-big upload fails before it is sent. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;

type Upload = { path: string; base64: string; size: number };

async function toUpload(file: File): Promise<Upload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { path: file.name, base64: btoa(binary), size: bytes.length };
}

/** Why the procedure refused, when it says (a file's path and what is wrong with it); else a generic line. */
function reason(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const { code, message } = e as { code: unknown; message?: unknown };
    if ((code === "BAD_REQUEST" || code === "CONFLICT") && typeof message === "string") return message;
  }
  return fallback;
}

type Props = {
  /** The package being edited; absent when creating. */
  pkg?: SkillPackage;
  onClose: () => void;
};

/** The "Create skill" sheet, or the editor of a user-made skill. Mount it only while open. */
export function SkillEditor({ pkg, onClose }: Props) {
  const { t } = useTranslation("skills");
  const details = useQuery({ ...orpc.skills.get.queryOptions({ input: { packageId: pkg?.packageId ?? "" } }), enabled: !!pkg });
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{pkg ? t("editor.edit") : t("editor.create")}</SheetTitle>
          <SheetDescription>{t("editor.description")}</SheetDescription>
        </SheetHeader>
        <div className="px-6 pb-6">
          {!pkg ? (
            <SkillForm onClose={onClose} />
          ) : details.data ? (
            <SkillForm pkg={details.data} onClose={onClose} />
          ) : details.error ? (
            <p role="alert" className="text-[13px] text-danger">
              {t("editor.failed")}
            </p>
          ) : (
            <p className="text-[13px] text-muted">{t("editor.loading")}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type Details = Awaited<ReturnType<typeof api.skills.get>>;

function SkillForm({ pkg, onClose }: { pkg?: Details; onClose: () => void }) {
  const { t } = useTranslation("skills");
  const format = useFormat();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.skills.key() });
  const create = useMutation(orpc.skills.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.skills.update.mutationOptions({ onSuccess: invalidate }));
  // Only the list: refetching the deleted package's details would fail (and be retried) before the sheet closes.
  const del = useMutation(
    orpc.skills.delete.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.skills.list.key() }) }),
  );
  const [name, setName] = useState(pkg?.name ?? "");
  const [description, setDescription] = useState(pkg?.description ?? "");
  const [instructions, setInstructions] = useState(pkg?.instructions ?? "");
  // null: keep the stored files (editing only).
  const [uploads, setUploads] = useState<Upload[] | null>(pkg ? null : []);
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || del.isPending;
  const current = pkg ? pkg.files.filter((f) => f.path !== `${pkg.name}/SKILL.md`).map((f) => ({ path: f.path.slice(pkg.name.length + 1), size: f.size })) : [];
  const shown = uploads ?? current;

  async function addFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    const added = await Promise.all([...list].map(toUpload));
    const tooBig = added.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) return setError(t("editor.tooBig", { path: tooBig.path }));
    const next = [...(uploads ?? []).filter((f) => !added.some((a) => a.path === f.path)), ...added];
    if (next.reduce((n, f) => n + f.size, 0) > MAX_PACKAGE_BYTES) return setError(t("editor.packageTooBig"));
    setUploads(next);
  }

  async function save() {
    setError(null);
    const fields = {
      name: name.trim(),
      description,
      instructions,
      requiredToolIds: pkg?.requiredTools.map((tool) => tool.id) ?? [],
      ...(uploads ? { files: uploads.map(({ path, base64 }) => ({ path, base64 })) } : {}),
    };
    try {
      if (pkg) await update.mutateAsync({ ...fields, packageId: pkg.packageId });
      else await create.mutateAsync(fields);
      onClose();
    } catch (e) {
      setError(reason(e, t("editor.saveFailed")));
    }
  }

  async function remove() {
    if (!pkg) return;
    setError(null);
    try {
      await del.mutateAsync({ packageId: pkg.packageId });
      onClose();
    } catch (e) {
      // CONFLICT names the agent that uses the skill.
      setError(reason(e, t("editor.deleteFailed")));
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <FormField label={t("editor.name")} htmlFor="skill-name" hint={t("editor.nameHint")}>
        <Input
          id="skill-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          pattern="[a-z0-9][a-z0-9\-]*"
          required
          autoFocus={!pkg}
        />
      </FormField>
      <FormField label={t("editor.descriptionLabel")} htmlFor="skill-description" hint={t("editor.descriptionHint")}>
        <Textarea
          id="skill-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1024}
          rows={2}
          required
          className="rounded-xl text-[14px]"
        />
      </FormField>
      <FormField label={t("editor.instructions")} htmlFor="skill-instructions" hint={t("editor.instructionsHint")}>
        <Textarea
          id="skill-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={100_000}
          rows={10}
          className="min-h-48 rounded-xl font-mono text-[13px]"
        />
      </FormField>

      <section aria-labelledby="skill-files" className="space-y-2">
        <h3 id="skill-files" className="text-[13px] font-medium text-muted">
          {t("editor.files")}
        </h3>
        {shown.length === 0 ? (
          <p className="text-[13px] text-faint">{t("editor.noFiles")}</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {shown.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 truncate font-mono">{f.path}</span>
                <span className="flex shrink-0 items-center gap-2 text-muted">
                  {format.size(f.size)}
                  {uploads && (
                    <button
                      type="button"
                      aria-label={t("editor.removeFile", { path: f.path })}
                      className="rounded p-0.5 hover:bg-hover"
                      onClick={() => setUploads(uploads.filter((u) => u.path !== f.path))}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-[13px] transition hover:bg-hover">
            {uploads ? t("editor.addFiles") : t("editor.replaceFiles")}
            <input
              type="file"
              multiple
              aria-label={uploads ? t("editor.addFiles") : t("editor.replaceFiles")}
              className="sr-only"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {pkg && uploads === null && current.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setUploads([])}>
              {t("editor.removeAll")}
            </Button>
          )}
          {pkg && uploads !== null && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setUploads(null)}>
              {t("editor.keepFiles")}
            </Button>
          )}
        </div>
      </section>

      <section aria-labelledby="skill-tools" className="space-y-1">
        <h3 id="skill-tools" className="text-[13px] font-medium text-muted">
          {t("editor.tools")}
        </h3>
        <p className="text-[13px] text-faint">
          {pkg && pkg.requiredTools.length > 0
            ? pkg.requiredTools.map((tool) => tool.name).join(", ")
            : t("editor.noTools")}
        </p>
      </section>

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" disabled={busy || !name.trim() || !description.trim()}>
          {pkg ? t("editor.save") : t("editor.create")}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("editor.cancel")}
        </Button>
        {pkg && (
          <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={busy} onClick={() => void remove()}>
            {t("editor.delete")}
          </Button>
        )}
      </div>
    </form>
  );
}
