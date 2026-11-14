import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";
import type { SkillPackage } from "./SkillEditor.tsx";
import { SkillFiles } from "./SkillFiles.tsx";

/** Text as the base64 the server takes, bytes kept as UTF-8. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Why the server refused (a file's path and what is wrong with it), when it says; else `fallback`. */
function reason(e: unknown, fallback: string): string {
  const { code, message } = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; message?: unknown };
  return (code === "BAD_REQUEST" || code === "NOT_FOUND") && typeof message === "string" && !message.startsWith("Input validation") ? message : fallback;
}

/**
 * The files of a plugin's skill package. A file its owner edits, adds or removes is theirs and
 * stays so through the plugin's updates; the others go on following the plugin.
 */
export function PluginSkillSheet({ pkg, onClose }: { pkg: SkillPackage; onClose: () => void }) {
  const { packageId } = pkg;
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.skills.key() });
  const detail = useQuery(orpc.skills.get.queryOptions({ input: { packageId } }));
  const setFile = useMutation(orpc.skills.setFile.mutationOptions({ onSuccess: invalidate }));
  const removeFile = useMutation(orpc.skills.removeFile.mutationOptions({ onSuccess: invalidate }));
  const reset = useMutation(orpc.plugins.resetOverride.mutationOptions({ onSuccess: invalidate }));
  // The file being written: one of the skill's, or a new one (`isNew`, its path typed).
  const [draft, setDraft] = useState<{ path: string; text: string; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = setFile.isPending || removeFile.isPending || reset.isPending;

  const run = async (work: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(reason(e, fallback));
      return false;
    }
  };

  async function edit(path: string) {
    await run(async () => {
      const { text } = await queryClient.fetchQuery({ ...orpc.skills.readFile.queryOptions({ input: { packageId, path } }), staleTime: 0 });
      if (text === null) throw { code: "BAD_REQUEST", message: `${path} isn't text: it can be removed, not edited here` };
      setDraft({ path, text, isNew: false });
    }, "Could not open the file. Try again.");
  }

  async function save() {
    if (!draft) return;
    if (await run(() => setFile.mutateAsync({ packageId, path: draft.path.trim(), base64: toBase64(draft.text) }), "Could not save the file. Check it and try again.")) setDraft(null);
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{pkg.name}</SheetTitle>
          <SheetDescription>
            It is {pkg.plugin?.name}'s. A file you edit, add or remove is yours and stays so when the plugin is updated; the others follow the plugin.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-6">
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          {detail.error && <p role="alert" className="text-[13px] text-danger">Could not load the skill's files.</p>}
          {draft ? (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <FormField label="Path" htmlFor="skill-file-path" hint={draft.isNew ? "Inside one of its skills, for example pdf/notes.md." : undefined}>
                <Input id="skill-file-path" className="font-mono" value={draft.path} readOnly={!draft.isNew} onChange={(e) => setDraft({ ...draft, path: e.target.value })} maxLength={500} required />
              </FormField>
              <FormField label="Content" htmlFor="skill-file-text">
                <Textarea id="skill-file-text" className="font-mono text-[13px]" rows={18} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              </FormField>
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={busy || !draft.path.trim()}>
                  Save
                </Button>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            detail.data && (
              <>
                <SkillFiles
                  files={detail.data.files}
                  removed={detail.data.removed}
                  busy={busy}
                  onEdit={(path) => void edit(path)}
                  onRemove={(path) => void run(() => removeFile.mutateAsync({ packageId, path }), "Could not remove the file. Try again.")}
                  onReset={(path) => void run(() => reset.mutateAsync({ kind: "skill", id: packageId, field: `file:${path}` }), "Could not reset the file. Try again.")}
                />
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft({ path: "", text: "", isNew: true })}>
                    Add a file
                  </Button>
                  <Button type="button" variant="ghost" onClick={onClose}>
                    Close
                  </Button>
                </div>
              </>
            )
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
