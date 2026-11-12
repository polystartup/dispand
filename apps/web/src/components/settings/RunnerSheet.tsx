import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { orpc } from "../../lib/api.ts";
import { AddRunner } from "./AddRunner.tsx";
import type { Runner } from "./HarnessSheet.tsx";
import { FormField } from "./parts.tsx";

/** Adds a runner (no `runner`) or renames and deletes one. Mount it only while open. */
export function RunnerSheet({ runner, onClose }: { runner?: Runner; onClose: () => void }) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{runner ? "Edit runner" : "Add a runner"}</SheetTitle>
          <SheetDescription>A runner is a small service on the machine where Claude Code is installed.</SheetDescription>
        </SheetHeader>
        <div className="px-6 pb-6">
          {runner ? <EditRunner runner={runner} onDone={onClose} /> : <AddRunner onCancel={onClose} onConnected={onClose} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EditRunner({ runner, onDone }: { runner: Runner; onDone: () => void }) {
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
      setError("Could not save the runner. Check the name and try again.");
    }
  }

  async function remove() {
    setError(null);
    try {
      await revoke.mutateAsync({ runnerId: runner.id });
      onDone();
    } catch (e) {
      const used = typeof e === "object" && e !== null && "code" in e && e.code === "CONFLICT";
      setError(used ? "A harness uses this runner. Delete or move the harness first." : "Could not delete the runner.");
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
        {runner.runnerUpdate === "current" && <p className="text-muted">Runner is up to date.</p>}
        {(runner.runnerUpdate === "available" || runner.runnerUpdate === "failed" || updating) && <>
          <p>{updating ? "Updating runner… It will reconnect when ready." : runner.runnerUpdate === "failed" ? "The update failed or the runner did not reconnect. You can retry." : "A runner update is available. The runner will restart; running sessions resume afterwards."}</p>
          <Button type="button" disabled={busy || updating} onClick={() => install.mutate({ runnerId: runner.id })}>
            {updating ? "Updating…" : "Update runner"}
          </Button>
        </>}
        {install.isError && <p role="alert" className="text-danger">Could not start the update. Check that the runner is reachable and try again.</p>}
      </div>
      <FormField label="Runner name" htmlFor="runner-name">
        <Input id="runner-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
      </FormField>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="space-y-3 rounded-xl border border-line p-4">
          <p className="text-[14px]">Delete {runner.name}? Its machine is disconnected and has to pair again to come back.</p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete runner
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={busy || !name.trim()}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={busy} onClick={() => setConfirming(true)}>
            Delete
          </Button>
        </div>
      )}
    </form>
  );
}
