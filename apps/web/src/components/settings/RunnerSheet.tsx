import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { orpc } from "../../lib/api.ts";
import { AddRunner } from "./AddRunner.tsx";
import type { Runner } from "./HarnessSheet.tsx";
import { FormField } from "./parts.tsx";

/** Adds a runner (no `runner`) or renames and deletes one. Mount it only while open. */
export function RunnerSheet({ runner, onClose }: { runner?: Runner; onClose: () => void }) {
  const { t } = useTranslation("harnesses");
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{runner ? t("runnerSheet.edit") : t("runnerSheet.add")}</SheetTitle>
          <SheetDescription>{t("runnerSheet.description")}</SheetDescription>
        </SheetHeader>
        <div className="px-6 pb-6">
          {runner ? <EditRunner runner={runner} onDone={onClose} /> : <AddRunner onCancel={onClose} onConnected={onClose} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EditRunner({ runner, onDone }: { runner: Runner; onDone: () => void }) {
  const { t } = useTranslation("harnesses");
  const [name, setName] = useState(runner.name);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.runners.key() });
  const update = useMutation(orpc.runners.update.mutationOptions({ onSuccess: invalidate }));
  const revoke = useMutation(orpc.runners.revoke.mutationOptions({ onSuccess: invalidate }));
  const install = useMutation(orpc.runners.installUpdate.mutationOptions({ onSuccess: invalidate }));
  const busy = update.isPending || revoke.isPending || install.isPending;
  const updating = runner.runnerUpdate === "updating";

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ runnerId: runner.id, name });
      onDone();
    } catch {
      setError(t("runnerSheet.saveFailed"));
    }
  }

  async function remove() {
    setError(null);
    try {
      await revoke.mutateAsync({ runnerId: runner.id });
      onDone();
    } catch (e) {
      const used = typeof e === "object" && e !== null && "code" in e && e.code === "CONFLICT";
      setError(used ? t("runnerSheet.inUse") : t("runnerSheet.deleteFailed"));
      setConfirming(false);
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
      <div className="space-y-2 text-[14px]">
        {runner.runnerUpdate === "current" && <p className="text-muted">{t("runnerSheet.current")}</p>}
        {(runner.runnerUpdate === "available" || runner.runnerUpdate === "failed" || updating) && <>
          <p>{updating ? t("runnerSheet.updating") : runner.runnerUpdate === "failed" ? t("runnerSheet.failed") : t("runnerSheet.available")}</p>
          <Button type="button" disabled={busy || updating} onClick={() => install.mutate({ runnerId: runner.id })}>
            {updating ? t("runnerSheet.updatingButton") : t("runnerSheet.update")}
          </Button>
        </>}
        {install.isError && <p role="alert" className="text-danger">{t("runnerSheet.startFailed")}</p>}
      </div>
      <FormField label={t("runnerSheet.name")} htmlFor="runner-name">
        <Input id="runner-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
      </FormField>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="space-y-3 rounded-xl border border-line p-4">
          <p className="text-[14px]">{t("runnerSheet.confirm", { name: runner.name })}</p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {t("runnerSheet.delete")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              {t("runnerSheet.keep")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={busy || !name.trim()}>
            {t("runnerSheet.save")}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t("runnerSheet.cancel")}
          </Button>
          <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={busy} onClick={() => setConfirming(true)}>
            {t("runnerSheet.deleteButton")}
          </Button>
        </div>
      )}
    </form>
  );
}
