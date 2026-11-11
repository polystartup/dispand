import { DEFAULT_TIMEZONE } from "@dispand/domain/workflows/schedule";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { orpc } from "../../lib/api.ts";
import { FormField } from "../settings/parts.tsx";
import { ScheduleTriggerPanel } from "../workflow/panels/ScheduleTriggerPanel.tsx";
import type { Trigger } from "./TriggerList.tsx";

type Starts = "chat" | "button" | "schedule";
const STARTS: [Starts, string, string][] = [
  ["chat", "Chat", "A conversation with the agent."],
  ["button", "Button", "One click starts the Job."],
  ["schedule", "Schedule", "The Job starts by itself, on a schedule."],
];

/** The browser's timezone when schedules accept it (they take IANA zones: not "UTC"), else the default. */
function localTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Intl.supportedValuesOf("timeZone").includes(zone) ? zone : DEFAULT_TIMEZONE;
}

type Props = {
  agentId: string;
  /** The trigger being edited; absent when creating. */
  trigger?: Trigger;
  onClose: () => void;
};

/** Creates or edits one of an agent's triggers. A trigger keeps its kind: manual (chat or button) or schedule. Mount it only while open. */
export function TriggerSheet({ agentId, trigger, onClose }: Props) {
  const queryClient = useQueryClient();
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.triggers.key() });
    onClose();
  };
  const create = useMutation(orpc.triggers.create.mutationOptions({ onSuccess: done }));
  const update = useMutation(orpc.triggers.update.mutationOptions({ onSuccess: done }));
  const remove = useMutation(orpc.triggers.delete.mutationOptions({ onSuccess: done }));
  const [name, setName] = useState(trigger?.name ?? "");
  const [instructions, setInstructions] = useState(trigger?.instructions ?? "");
  const [starts, setStarts] = useState<Starts>(trigger ? (trigger.config.kind === "manual" ? trigger.config.placement : "schedule") : "chat");
  const [schedule, setSchedule] = useState(
    trigger?.config.kind === "schedule" ? { cron: trigger.config.cron, timezone: trigger.config.timezone } : { cron: "0 9 * * *", timezone: localTimezone() },
  );
  const [oneAtATime, setOneAtATime] = useState(trigger?.concurrency === "one-at-a-time");
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || remove.isPending;
  const error = problem ?? create.error?.message ?? update.error?.message ?? remove.error?.message;
  // A trigger keeps its kind: a manual one moves between chat and button only.
  const choices = STARTS.filter(([s]) => !trigger || (trigger.kind === "schedule" ? s === "schedule" : s !== "schedule"));

  function save(form: HTMLFormElement) {
    if (!name.trim()) return setProblem("Give the trigger a name");
    // The schedule panel keeps what is typed while it can't be saved: never save another schedule than the one shown.
    if (form.querySelector('[aria-invalid="true"]')) return setProblem("Fix the schedule first");
    setProblem(null);
    const fields = {
      name: name.trim(),
      instructions,
      concurrency: oneAtATime ? ("one-at-a-time" as const) : ("parallel" as const),
      config: starts === "schedule" ? { kind: "schedule" as const, ...schedule } : { kind: "manual" as const, placement: starts },
    };
    if (trigger) update.mutate({ id: trigger.id, ...fields, enabled });
    else create.mutate({ agentId, ...fields });
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{trigger ? "Edit trigger" : "New trigger"}</SheetTitle>
          <SheetDescription>What makes this agent work. Each time it fires, the agent gets a Job.</SheetDescription>
        </SheetHeader>
        <form
          className="grid gap-5 px-6 pb-6"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save(e.currentTarget);
          }}
        >
          <FormField label="Name" htmlFor="trigger-name">
            <Input id="trigger-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-muted">Starts with</p>
            <div role="radiogroup" aria-label="Starts with" className="grid gap-1 rounded-xl bg-active p-1" style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}>
              {choices.map(([s, label]) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={starts === s}
                  onClick={() => setStarts(s)}
                  className={cn("rounded-lg py-1.5 text-[13px] font-medium transition", starts === s ? "bg-surface shadow-card" : "text-muted hover:text-fg")}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[12px] text-faint">{STARTS.find(([s]) => s === starts)![2]}</p>
          </div>
          <FormField label="Instructions" htmlFor="trigger-instructions" hint="What the agent is asked to do each time this trigger fires.">
            <Textarea id="trigger-instructions" rows={5} value={instructions} maxLength={100_000} onChange={(e) => setInstructions(e.target.value)} />
          </FormField>
          {starts === "schedule" ? (
            <>
              <ScheduleTriggerPanel
                field={{ id: "trigger", key: "trigger", type: "schedule", label: name, ...schedule }}
                schedule={trigger?.nextFireAt ? { enabled, nextFireAt: trigger.nextFireAt } : null}
                fires={(trigger?.lastFires ?? []).map((f) => ({ scheduledFor: f.scheduledFor, status: f.status, runId: f.runId ?? null, message: f.message ?? null }))}
                onChange={({ cron, timezone }) => setSchedule({ cron, timezone })}
                onPause={setEnabled}
              />
              <label className="flex items-start gap-3 text-[14px]">
                <input type="checkbox" checked={oneAtATime} onChange={(e) => setOneAtATime(e.target.checked)} className="mt-1 size-4 accent-[var(--color-accent)]" />
                <span>
                  One at a time
                  <span className="block text-[12px] text-faint">A time that comes while this trigger's Job is still going is skipped.</span>
                </span>
              </label>
            </>
          ) : (
            trigger && (
              <label className="flex items-center justify-between gap-3 text-[14px]">
                Enabled
                <input type="checkbox" role="switch" aria-label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
              </label>
            )
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <Button type="submit" disabled={busy}>
              {trigger ? "Save" : "Create trigger"}
            </Button>
            {trigger && (
              <Button type="button" variant="ghost" className="text-danger" disabled={busy} onClick={() => remove.mutate({ id: trigger.id })}>
                Delete trigger
              </Button>
            )}
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
