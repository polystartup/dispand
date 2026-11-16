import { DEFAULT_TIMEZONE, knownTimezone } from "@dispand/domain/workflows/schedule";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Overridden } from "../settings/Overridden.tsx";
import { StemMarks } from "../settings/StemMarks.tsx";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { orpc } from "../../lib/api.ts";
import { FormField } from "../settings/parts.tsx";
import { ScheduleTriggerPanel } from "../workflow/panels/ScheduleTriggerPanel.tsx";
import { type PollForm, PollTriggerPanel } from "./PollTriggerPanel.tsx";
import { type ChangeConfig, PrimitiveTriggerPanel } from "./PrimitiveTriggerPanel.tsx";
import type { Trigger } from "./TriggerList.tsx";

type Starts = "chat" | "button" | "schedule" | "change" | "poll";
const STARTS: Starts[] = ["chat", "button", "schedule", "change", "poll"];

/** What a trigger's kind lets it become: a manual one moves between chat and button only. */
const KINDS: Record<string, Starts[]> = { manual: ["chat", "button"], schedule: ["schedule"], primitive: ["change"], poll: ["poll"] };

/** The browser's timezone when schedules accept it, else the default. */
export function localTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return knownTimezone(zone) ? zone : DEFAULT_TIMEZONE;
}

type Props = {
  agentId: string;
  /** The trigger being edited; absent when creating. */
  trigger?: Trigger;
  onClose: () => void;
};

/** Creates or edits one of an agent's triggers. A trigger keeps its kind: manual (chat or button), schedule or table change. Mount it only while open. */
export function TriggerSheet({ agentId, trigger, onClose }: Props) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.triggers.key() });
    onClose();
  };
  const create = useMutation(orpc.triggers.create.mutationOptions({ onSuccess: done }));
  const update = useMutation(orpc.triggers.update.mutationOptions({ onSuccess: done }));
  const remove = useMutation(orpc.triggers.delete.mutationOptions({ onSuccess: done }));
  // Back to the plugin's value: the sheet closes, and opens again on the trigger as it is then.
  const reset = useMutation(orpc.plugins.resetOverride.mutationOptions({ onSuccess: done }));
  const [name, setName] = useState(trigger?.name ?? "");
  const [instructions, setInstructions] = useState(trigger?.instructions ?? "");
  const [starts, setStarts] = useState<Starts>(
    trigger ? (trigger.config.kind === "manual" ? trigger.config.placement : trigger.config.kind === "schedule" ? "schedule" : trigger.config.kind === "poll" ? "poll" : "change") : "chat",
  );
  const [poll, setPoll] = useState<PollForm>(
    trigger?.config.kind === "poll"
      ? { ...trigger.config, arguments: JSON.stringify(trigger.config.arguments, null, 2) }
      : { toolId: "", action: "", arguments: "{}", itemsPath: "", idPath: "id", interval: 300 },
  );
  const [change, setChange] = useState<ChangeConfig>(trigger?.config.kind === "primitive" ? trigger.config : { tableId: "", operations: ["updated"] });
  const [rateCap, setRateCap] = useState(trigger?.rateCap ?? 60);
  const [schedule, setSchedule] = useState(
    trigger?.config.kind === "schedule" ? { cron: trigger.config.cron, timezone: trigger.config.timezone } : { cron: "0 9 * * *", timezone: localTimezone() },
  );
  const [oneAtATime, setOneAtATime] = useState(trigger?.concurrency === "one-at-a-time");
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || remove.isPending;
  const error = problem ?? create.error?.message ?? update.error?.message ?? remove.error?.message;
  const overriddenLabels = {
    name: t("sheet.overridden.name"),
    instructions: t("sheet.overridden.instructions"),
    config: t("sheet.overridden.config"),
    concurrency: t("sheet.overridden.concurrency"),
    rateCap: t("sheet.overridden.rateCap"),
  };
  const choices = STARTS.filter((s) => !trigger || KINDS[trigger.kind]!.includes(s));

  function save(form: HTMLFormElement) {
    if (!name.trim()) return setProblem(t("sheet.problem.name"));
    // The schedule panel keeps what is typed while it can't be saved: never save another schedule than the one shown.
    if (form.querySelector('[aria-invalid="true"]')) return setProblem(t("sheet.problem.schedule"));
    if (starts === "change") {
      if (!change.tableId) return setProblem(t("sheet.problem.table"));
      if (change.operations.length === 0) return setProblem(t("sheet.problem.operations"));
      if (change.fields?.length === 0) return setProblem(t("sheet.problem.fields"));
      if (!Number.isInteger(rateCap) || rateCap < 1 || rateCap > 1000) return setProblem(t("sheet.problem.cap"));
    }
    let pollArguments: Record<string, unknown> = {};
    if (starts === "poll") {
      if (!poll.toolId || !poll.action) return setProblem(t("sheet.problem.tool"));
      try {
        pollArguments = JSON.parse(poll.arguments || "{}") as Record<string, unknown>;
      } catch {
        return setProblem(t("sheet.problem.json"));
      }
      if (typeof pollArguments !== "object" || pollArguments === null || Array.isArray(pollArguments)) return setProblem(t("sheet.problem.jsonObject"));
      if (!poll.idPath.trim()) return setProblem(t("sheet.problem.idPath"));
      if (!Number.isInteger(poll.interval) || poll.interval < 60 || poll.interval > 86_400) return setProblem(t("sheet.problem.interval"));
      if (!Number.isInteger(rateCap) || rateCap < 1 || rateCap > 1000) return setProblem(t("sheet.problem.cap"));
    }
    setProblem(null);
    const fields = {
      name: name.trim(),
      instructions,
      concurrency: oneAtATime ? ("one-at-a-time" as const) : ("parallel" as const),
      ...(starts === "change" || starts === "poll" ? { rateCap } : {}),
      config:
        starts === "schedule"
          ? { kind: "schedule" as const, ...schedule }
          : starts === "change"
            ? { kind: "primitive" as const, ...change }
            : starts === "poll"
              ? { kind: "poll" as const, ...poll, arguments: pollArguments }
              : { kind: "manual" as const, placement: starts },
    };
    if (trigger) update.mutate({ id: trigger.id, ...fields, enabled });
    else create.mutate({ agentId, ...fields });
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{trigger ? t("sheet.edit") : t("sheet.create")}</SheetTitle>
          <SheetDescription>{t("sheet.description")}</SheetDescription>
        </SheetHeader>
        {trigger?.plugin && (
          <div className="px-6">
            <Overridden
              plugin={trigger.plugin.name}
              overridden={trigger.overridden}
              labels={overriddenLabels}
              busy={reset.isPending}
              onReset={(field) => reset.mutate({ kind: "trigger", id: trigger.id, field })}
            />
            <StemMarks kind="trigger" id={trigger.id} labels={overriddenLabels} onResolved={() => void done()} />
            {reset.error && (
              <p role="alert" className="mt-2 text-[13px] text-danger">
                {t("sheet.resetFailed")}
              </p>
            )}
          </div>
        )}
        <form
          className="grid gap-5 px-6 pb-6"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save(e.currentTarget);
          }}
        >
          <FormField label={t("sheet.name")} htmlFor="trigger-name">
            <Input id="trigger-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-muted">{t("sheet.starts")}</p>
            <div role="radiogroup" aria-label={t("sheet.starts")} className="grid gap-1 rounded-xl bg-active p-1" style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}>
              {choices.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={starts === s}
                  onClick={() => setStarts(s)}
                  className={cn("rounded-lg py-1.5 text-[13px] font-medium transition", starts === s ? "bg-surface shadow-card" : "text-muted hover:text-fg")}
                >
                  {t(`sheet.start.${s}.label`)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[12px] text-faint">{t(`sheet.start.${starts}.hint`)}</p>
          </div>
          <FormField label={t("sheet.instructions")} htmlFor="trigger-instructions" hint={t("sheet.instructionsHint")}>
            <Textarea id="trigger-instructions" rows={5} value={instructions} maxLength={100_000} onChange={(e) => setInstructions(e.target.value)} />
          </FormField>
          {starts === "poll" ? (
            <>
              <PollTriggerPanel agentId={agentId} config={poll} rateCap={rateCap} polls={trigger?.lastPolls ?? []} onChange={setPoll} onRateCap={setRateCap} />
              <label className="flex items-start gap-3 text-[14px]">
                <input type="checkbox" checked={oneAtATime} onChange={(e) => setOneAtATime(e.target.checked)} className="mt-1 size-4 accent-[var(--color-accent)]" />
                <span>
                  {t("sheet.oneAtATime")}
                  <span className="block text-[12px] text-faint">{t("sheet.oneAtATimePoll")}</span>
                </span>
              </label>
              {trigger && (
                <label className="flex items-center justify-between gap-3 text-[14px]">
                  {t("sheet.enabled")}
                  <input type="checkbox" role="switch" aria-label={t("sheet.enabled")} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                </label>
              )}
            </>
          ) : starts === "change" ? (
            <>
              <PrimitiveTriggerPanel config={change} rateCap={rateCap} events={trigger?.lastEvents ?? []} onChange={setChange} onRateCap={setRateCap} />
              <label className="flex items-start gap-3 text-[14px]">
                <input type="checkbox" checked={oneAtATime} onChange={(e) => setOneAtATime(e.target.checked)} className="mt-1 size-4 accent-[var(--color-accent)]" />
                <span>
                  {t("sheet.oneAtATime")}
                  <span className="block text-[12px] text-faint">{t("sheet.oneAtATimeChange")}</span>
                </span>
              </label>
              {trigger && (
                <label className="flex items-center justify-between gap-3 text-[14px]">
                  {t("sheet.enabled")}
                  <input type="checkbox" role="switch" aria-label={t("sheet.enabled")} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                </label>
              )}
            </>
          ) : starts === "schedule" ? (
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
                  {t("sheet.oneAtATime")}
                  <span className="block text-[12px] text-faint">{t("sheet.oneAtATimeSchedule")}</span>
                </span>
              </label>
            </>
          ) : (
            trigger && (
              <label className="flex items-center justify-between gap-3 text-[14px]">
                {t("sheet.enabled")}
                <input type="checkbox" role="switch" aria-label={t("sheet.enabled")} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
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
              {trigger ? t("sheet.save") : t("sheet.createButton")}
            </Button>
            {trigger && !trigger.plugin && (
              <Button type="button" variant="ghost" className="text-danger" disabled={busy} onClick={() => remove.mutate({ id: trigger.id })}>
                {t("sheet.delete")}
              </Button>
            )}
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
