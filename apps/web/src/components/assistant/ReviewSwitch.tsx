import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../../lib/api.ts";
import { localTimezone } from "../agents/TriggerSheet.tsx";

/**
 * The owner's switch for the Assistant's weekly review: off until they turn it on. Turned on, it
 * runs in the browser's time zone, the owner's; its schedule stays editable on the Assistant's
 * agent page like any trigger.
 */
export function ReviewSwitch({ triggerId }: { triggerId: string }) {
  const queryClient = useQueryClient();
  const trigger = useQuery(orpc.triggers.get.queryOptions({ input: { id: triggerId } }));
  const save = useMutation(orpc.triggers.update.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.triggers.key() }) }));
  const config = trigger.data?.config;
  if (config?.kind !== "schedule") return null;
  const toggle = (enabled: boolean) => save.mutate({ id: triggerId, enabled, ...(enabled ? { config: { ...config, timezone: localTimezone() } } : {}) });
  return (
    <div>
      <label className="flex items-start gap-2 text-[14px]">
        <input type="checkbox" checked={trigger.data!.enabled} disabled={save.isPending} onChange={(e) => toggle(e.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" />
        <span>
          Weekly review
          <span className="block text-[12px] text-muted">Every Monday, the Assistant looks for what could be better and asks for each change in your Inbox.</span>
        </span>
      </label>
      {save.error && <p role="alert" className="mt-1 text-[13px] text-danger">{save.error.message}</p>}
    </div>
  );
}
