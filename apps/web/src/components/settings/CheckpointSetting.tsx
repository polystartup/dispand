import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";

/**
 * The workspace's checkpoint (design 6.1): how many Jobs of one root cause (a message, a
 * schedule, a change) go before you are asked whether that work goes on. Nothing is cut.
 */
export function CheckpointSetting() {
  const queryClient = useQueryClient();
  const current = useQuery(orpc.workspace.checkpoint.queryOptions());
  // What is typed, while editing; otherwise the field follows the setting (another tab, an approved proposal).
  const [typed, setTyped] = useState<string | null>(null);
  const save = useMutation(orpc.workspace.setCheckpoint.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.workspace.checkpoint.key() }) }));
  if (!current.data) return null;
  const value = typed ?? String(current.data.checkpoint);
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100_000;
  return (
    <section aria-labelledby="checkpoint" className="mt-8">
      <h2 id="checkpoint" className="text-[17px] font-medium tracking-tight">
        Checkpoint
      </h2>
      <p className="mb-3 text-[13px] text-muted">
        After this many Jobs from one cause (your message, a schedule, a change to a table), that work pauses and the Inbox asks whether it goes on. Raising it lets agents spend more before you are asked.
      </p>
      <form
        className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface px-5 py-4 shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ checkpoint: n }, { onSuccess: () => setTyped(null) });
        }}
      >
        <label htmlFor="checkpoint-jobs" className="text-[13px] text-muted">
          Ask every
        </label>
        <Input
          id="checkpoint-jobs"
          type="number"
          min={1}
          max={100000}
          value={value}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={!valid}
          className="w-28"
        />
        <span className="text-[13px] text-muted">Jobs</span>
        <Button type="submit" variant="outline" disabled={!valid || n === current.data.checkpoint || save.isPending}>
          Save
        </Button>
        {!valid && (
          <p role="alert" className="w-full text-[13px] text-danger">
            A whole number from 1 to 100,000
          </p>
        )}
        {save.error && (
          <p role="alert" className="w-full text-[13px] text-danger">
            {save.error.message}
          </p>
        )}
      </form>
    </section>
  );
}
