import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "../../lib/api.ts";
import { refusal } from "./PluginInstallSheet.tsx";
import { type RemovalChoice, RemovalChoices, removalPlan } from "./PluginRemoval.tsx";
import { NativeMoves, ReleaseNotes, startingTicks, TableChanges, UpdatePlan } from "./PluginUpdate.tsx";

export type UpdatePreview = Awaited<ReturnType<typeof api.plugins.updatePreview>>;

/**
 * An update that needs its owner's eyes: what it changes, shown before anything is applied.
 * Confirming applies exactly what is shown here; Cancel leaves the plugin as it is. Mount it only while open.
 */
export function PluginUpdateSheet({ id, name, preview, onClose, onUpdated }: { id: string; name: string; preview: UpdatePreview; onClose: () => void; onUpdated: (result: Awaited<ReturnType<typeof api.plugins.update>>) => void }) {
  const { t } = useTranslation(["plugins", "messages"]);
  const [take, setTake] = useState<string[]>([]);
  const [stem, setStem] = useState<string[]>([]);
  // What the new version drops: what is in use is kept unless the owner says otherwise, as at an uninstall.
  const [removing, setRemoving] = useState<Record<string, RemovalChoice>>({});
  const plan = removalPlan(preview.removals, removing);
  // Each table's changes, ticked as they start.
  const [ticked, setTicked] = useState(() => startingTicks(preview.tables));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onUpdated(await api.plugins.update({ id, reviewed: preview.reviewed, take, choices: plan.choices, tables: ticked, native: preview.native.harnesses.map((h) => h.id), stem }));
      onClose();
    } catch (e) {
      setError(refusal(e, t("update.failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{t("update.title", { name })}</SheetTitle>
          <SheetDescription>{t("update.description")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-6">
          <ReleaseNotes notes={preview.releaseNotes} />
          <UpdatePlan
            conflicts={preview.conflicts}
            changes={preview.changes}
            names={preview.names}
            take={take}
            busy={busy}
            onTake={(key, taken) => setTake((prev) => (taken ? [...prev.filter((k) => k !== key), key] : prev.filter((k) => k !== key)))}
            additions={preview.additions}
            stem={stem}
            onStem={(key, handed) => setStem((prev) => (handed ? [...prev.filter((k) => k !== key), key] : prev.filter((k) => k !== key)))}
          />
          {stem.length > 0 && <p className="text-[13px] text-muted">{t("update.stem", { count: stem.length, assistant: t("messages:agent.assistant.name") })}</p>}
          {preview.tables.length > 0 && (
            <section aria-labelledby="update-tables" className="space-y-2">
              <h3 id="update-tables" className="text-[13px] font-medium text-muted">
                {t("update.tables")}
              </h3>
              <TableChanges
                tables={preview.tables}
                ticked={ticked}
                busy={busy}
                onTick={(tableId, key) => setTicked((prev) => ({ ...prev, [tableId]: (prev[tableId] ?? []).includes(key) ? prev[tableId]!.filter((k) => k !== key) : [...(prev[tableId] ?? []), key] }))}
              />
            </section>
          )}
          {preview.removals.length > 0 && (
            <section aria-labelledby="update-removals" className="space-y-2">
              <h3 id="update-removals" className="text-[13px] font-medium text-muted">
                {t("update.removals")}
              </h3>
              <RemovalChoices plan={plan} busy={busy} onChange={(key, choice) => setRemoving((prev) => ({ ...prev, [key]: choice }))} />
            </section>
          )}
          <NativeMoves native={preview.native} />
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" disabled={busy} onClick={() => void confirm()}>
              {busy ? t("update.updating") : t("update.submit")}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t("update.cancel")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
