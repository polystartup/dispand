import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type api, orpc } from "../../lib/api.ts";
import { Empty, List } from "../settings/parts.tsx";
import { at } from "../workflow/panels/ScheduleTriggerPanel.tsx";
import { TriggerSheet } from "./TriggerSheet.tsx";

export type Trigger = Awaited<ReturnType<typeof api.triggers.list>>[number];

const fireText = { started: "started", "skipped-overlap": "skipped, a Job was still going", refused: "refused" } as const;

/** What a trigger does, in a line: how it starts and, for a schedule, when it next fires. */
function summary(t: Trigger): string {
  if (t.config.kind === "manual") return t.config.placement === "chat" ? "Chat" : "Button";
  if (!t.enabled) return "Schedule · Paused";
  return t.nextFireAt ? `Schedule · Next: ${at(t.nextFireAt, t.config.timezone)} (${t.config.timezone})` : "Schedule";
}

/** The agent's triggers: what makes it work. Each opens its sheet; a manual one can go on Home. */
export function TriggerList({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const triggers = useQuery(orpc.triggers.list.queryOptions({ input: { agentId } }));
  const home = useQuery(orpc.pages.home.queryOptions());
  const addToHome = useMutation(orpc.widgets.create.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.pages.key() }) }));
  // undefined: closed; null: a new trigger.
  const [open, setOpen] = useState<Trigger | null | undefined>(undefined);
  const onHome = (id: string) => home.data?.widgets.some((w) => w.type === "trigger-form" && w.triggerId === id) ?? false;

  if (triggers.error) return <p role="alert" className="text-[14px] text-danger">Could not load the triggers.</p>;
  if (!triggers.data) return null;
  const add = (
    <Button onClick={() => setOpen(null)}>
      <Plus aria-hidden />
      New trigger
    </Button>
  );
  return (
    <>
      {triggers.data.length === 0 ? (
        <Empty title="No trigger yet" text="A trigger makes this agent work: a chat or a button you start, or a schedule.">
          {add}
        </Empty>
      ) : (
        <>
          <div className="mb-4 flex justify-end">{add}</div>
          <List>
            {triggers.data.map((t) => {
              const last = t.lastFires[0];
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
                  <button type="button" onClick={() => setOpen(t)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[15px] font-medium">{t.name}</span>
                    <span className="block text-[13px] text-muted">{summary(t)}</span>
                    {last && (
                      <span className={`block text-[13px] ${last.status === "refused" ? "text-danger" : "text-faint"}`}>
                        Last: {at(last.scheduledFor, t.config.kind === "schedule" ? t.config.timezone : "UTC")}, {fireText[last.status]}
                        {last.message ? `: ${last.message}` : ""}
                      </span>
                    )}
                  </button>
                  {t.config.kind === "manual" &&
                    (onHome(t.id) ? (
                      <span className="text-[13px] text-muted">On Home</span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Add ${t.name} to Home`}
                        disabled={!home.data || addToHome.isPending}
                        onClick={() => home.data && addToHome.mutate({ pageId: home.data.id, type: "trigger-form", triggerId: t.id })}
                      >
                        Add to Home
                      </Button>
                    ))}
                </li>
              );
            })}
          </List>
          {addToHome.error && (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {addToHome.error.message}
            </p>
          )}
        </>
      )}
      {open !== undefined && <TriggerSheet key={open?.id ?? "new"} agentId={agentId} trigger={open ?? undefined} onClose={() => setOpen(undefined)} />}
    </>
  );
}
