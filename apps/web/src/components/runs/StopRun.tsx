import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";

/** Stops a run or a Job still going, after a confirmation: what its sessions were doing is cut. */
export function StopRun({ runId, status }: { runId: string; status: string }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const stop = useMutation(
    orpc.runs.stop.mutationOptions({
      onSettled: () => {
        setAsking(false);
        void queryClient.invalidateQueries({ queryKey: orpc.runs.list.key() });
      },
    }),
  );
  if (status !== "running" && status !== "waiting") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {asking ? (
        <>
          <Button variant="outline" size="sm" className="text-danger" disabled={stop.isPending} onClick={() => stop.mutate({ runId })}>
            Stop this run
          </Button>
          <Button variant="ghost" size="sm" disabled={stop.isPending} onClick={() => setAsking(false)}>
            Keep it going
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
          Stop
        </Button>
      )}
      {stop.error && (
        <p role="alert" className="text-[13px] text-danger">
          {stop.error.message}
        </p>
      )}
    </div>
  );
}
