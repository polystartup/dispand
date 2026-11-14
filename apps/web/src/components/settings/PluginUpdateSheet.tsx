import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "../../lib/api.ts";
import { refusal } from "./PluginInstallSheet.tsx";
import { UpdatePlan } from "./PluginUpdate.tsx";

export type UpdatePreview = Awaited<ReturnType<typeof api.plugins.updatePreview>>;

/**
 * An update that needs its owner's eyes: what it changes, shown before anything is applied.
 * Confirming applies exactly what is shown here; Cancel leaves the plugin as it is. Mount it only while open.
 */
export function PluginUpdateSheet({ id, name, preview, onClose, onUpdated }: { id: string; name: string; preview: UpdatePreview; onClose: () => void; onUpdated: (result: Awaited<ReturnType<typeof api.plugins.update>>) => void }) {
  const [take, setTake] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onUpdated(await api.plugins.update({ id, reviewed: preview.reviewed, take }));
      onClose();
    } catch (e) {
      setError(refusal(e, "Could not update the plugin. It may have changed since: close this and update again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">Update {name}</SheetTitle>
          <SheetDescription>What this update changes. What you changed yourself stays yours unless you take the plugin's value. Nothing is applied until you confirm.</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-6">
          <UpdatePlan
            conflicts={preview.conflicts}
            changes={preview.changes}
            names={preview.names}
            take={take}
            busy={busy}
            onTake={(key, taken) => setTake((prev) => (taken ? [...prev.filter((k) => k !== key), key] : prev.filter((k) => k !== key)))}
          />
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Updating…" : "Update"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
