import type { ScheduleField } from "@dispand/domain/workflows/model";
import { cronProblem, fromCron, nextFires, toCron, type SchedulePreset } from "@dispand/domain/workflows/schedule";
import { useId, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FormField } from "../../settings/parts.tsx";
import { selectClass } from "../../data/NewFieldPopover.tsx";

/** One fire of the schedule, as `workflows.get` gives it. */
export type ScheduleFire = { scheduledFor: Date; status: "started" | "skipped-overlap" | "refused"; runId: string | null; message: string | null };

type Kind = SchedulePreset["kind"] | "custom";
const KINDS: [Kind, string][] = [
  ["hourly", "Every hour"],
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["custom", "Custom"],
];
/** Monday first, as the owner's week. */
const WEEKDAYS: [0 | 1 | 2 | 3 | 4 | 5 | 6, string][] = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
];

let zones: string[] | undefined;
function timezones(): string[] {
  return (zones ??= Intl.supportedValuesOf("timeZone"));
}

/** "Thu 5 Nov, 09:00" in `timezone`. */
function at(date: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/** The preset of `kind`, keeping what the current one has in common with it. */
function presetOf(kind: SchedulePreset["kind"], current: SchedulePreset | null): SchedulePreset {
  const time = current && "time" in current ? current.time : "09:00";
  switch (kind) {
    case "hourly":
      return { kind, minute: current?.kind === "hourly" ? current.minute : Number(time.slice(3)) };
    case "daily":
    case "weekdays":
      return { kind, time };
    case "weekly":
      return { kind, weekday: current?.kind === "weekly" ? current.weekday : 1, time };
    case "monthly":
      return { kind, day: current?.kind === "monthly" ? current.day : 1, time };
  }
}

/**
 * A schedule trigger's body: how often (presets, or a cron), the timezone, the next three runs,
 * a Paused switch, and what the latest fires did. A cron or timezone that can't fire is shown,
 * never saved.
 */
export function ScheduleTriggerPanel({
  field,
  schedule,
  fires,
  now = new Date(),
  onChange,
  onPause,
  runLink = (runId, children) => <a href={`/settings/workflows/runs/${runId}`}>{children}</a>,
}: {
  field: ScheduleField;
  /** The saved schedule; null until the first save with this trigger lands. */
  schedule: { enabled: boolean; nextFireAt: Date } | null;
  fires: ScheduleFire[];
  now?: Date;
  onChange: (field: ScheduleField) => void;
  onPause: (enabled: boolean) => void;
  runLink?: (runId: string, children: ReactNode) => ReactNode;
}) {
  const ids = { cron: useId(), tz: useId(), zones: useId(), problem: useId() };
  const preset = fromCron(field.cron);
  const [kind, setKind] = useState<Kind>(preset?.kind ?? "custom");
  // What is typed, kept while it can't be saved.
  const [cron, setCron] = useState(field.cron);
  const [timezone, setTimezone] = useState(field.timezone);
  const cronIssue = kind === "custom" ? cronProblem(cron, field.timezone) : null;
  const tzIssue = timezones().includes(timezone) ? null : "Unknown timezone";

  function save(patch: Partial<ScheduleField>) {
    const next = { ...field, ...patch };
    if (cronProblem(next.cron, next.timezone) === null) onChange(next);
  }
  function pick(next: Kind) {
    setKind(next);
    if (next === "custom") setCron(field.cron);
    else save({ cron: toCron(presetOf(next, preset)) });
  }
  function setPreset(p: SchedulePreset) {
    save({ cron: toCron(p) });
  }

  const shown = kind !== "custom" && preset?.kind === kind ? preset : null;
  const next = cronProblem(field.cron, field.timezone) === null ? nextFires(field.cron, field.timezone, now, 3) : [];

  return (
    <>
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-muted">Repeat</p>
        <div role="radiogroup" aria-label="Repeat" className="grid grid-cols-2 gap-1 rounded-xl bg-active p-1 sm:grid-cols-3">
          {KINDS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => pick(k)}
              className={cn("rounded-lg py-1.5 text-[13px] font-medium transition", kind === k ? "bg-surface shadow-card" : "text-muted hover:text-fg")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {shown?.kind === "hourly" && (
        <FormField label="Minute" htmlFor="schedule-minute" hint="Past each hour.">
          <Input
            id="schedule-minute"
            type="number"
            min={0}
            max={59}
            value={shown.minute}
            onChange={(e) => {
              const minute = Number(e.target.value);
              if (Number.isInteger(minute) && minute >= 0 && minute <= 59) setPreset({ kind: "hourly", minute });
            }}
          />
        </FormField>
      )}
      {shown?.kind === "weekly" && (
        <FormField label="Day" htmlFor="schedule-weekday">
          <select id="schedule-weekday" value={shown.weekday} onChange={(e) => setPreset({ ...shown, weekday: Number(e.target.value) as typeof shown.weekday })} className={selectClass}>
            {WEEKDAYS.map(([d, label]) => (
              <option key={d} value={d}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
      )}
      {shown?.kind === "monthly" && (
        <FormField label="Day of the month" htmlFor="schedule-day" hint="Up to the 28th, so every month has it.">
          <select id="schedule-day" value={shown.day} onChange={(e) => setPreset({ ...shown, day: Number(e.target.value) })} className={selectClass}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </FormField>
      )}
      {shown && shown.kind !== "hourly" && (
        <FormField label="Time" htmlFor="schedule-time">
          <Input
            id="schedule-time"
            type="time"
            step={60}
            value={shown.time}
            onChange={(e) => {
              if (/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) setPreset({ ...shown, time: e.target.value });
            }}
          />
        </FormField>
      )}
      {kind === "custom" && (
        <FormField label="Cron" htmlFor={ids.cron} hint="minute hour day month weekday, e.g. */15 9-17 * * 1-5">
          <Input
            id={ids.cron}
            value={cron}
            maxLength={100}
            className="font-mono text-[13px]"
            aria-invalid={cronIssue !== null}
            aria-describedby={cronIssue ? ids.problem : undefined}
            onChange={(e) => {
              setCron(e.target.value);
              save({ cron: e.target.value.trim() });
            }}
          />
          {cronIssue && (
            <p id={ids.problem} role="alert" className="mt-1.5 text-[13px] text-danger">
              {cronIssue}
            </p>
          )}
        </FormField>
      )}

      <FormField label="Timezone" htmlFor={ids.tz}>
        <Input
          id={ids.tz}
          value={timezone}
          maxLength={64}
          list={ids.zones}
          aria-invalid={tzIssue !== null}
          onChange={(e) => {
            setTimezone(e.target.value);
            if (timezones().includes(e.target.value)) save({ timezone: e.target.value });
          }}
        />
        <datalist id={ids.zones}>
          {timezones().map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        {tzIssue && (
          <p role="alert" className="mt-1.5 text-[13px] text-danger">
            {tzIssue}
          </p>
        )}
      </FormField>

      {next.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Next runs ({field.timezone})</p>
          <ul aria-label="Next runs" className="space-y-1 text-[14px]">
            {next.map((d) => (
              <li key={d.getTime()}>{at(d, field.timezone)}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex items-center justify-between gap-3 text-[14px]">
        <span>
          Paused
          {!schedule && <span className="block text-[12px] text-faint">Once the schedule is saved.</span>}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Paused"
          disabled={!schedule}
          checked={schedule ? !schedule.enabled : false}
          onChange={(e) => onPause(!e.target.checked)}
          className="size-4 accent-[var(--color-accent)]"
        />
      </label>

      {fires.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Recent</p>
          <ul aria-label="Recent" className="space-y-1.5 text-[14px]">
            {fires.map((f) => (
              <li key={f.scheduledFor.getTime()} className="flex flex-wrap justify-between gap-x-3">
                <span className="text-muted">{at(f.scheduledFor, field.timezone)}</span>
                <span className={f.status === "refused" ? "text-danger" : undefined}>
                  {f.status === "started" && f.runId
                    ? runLink(f.runId, "Started")
                    : f.status === "started"
                      ? "Started"
                      : f.status === "skipped-overlap"
                        ? "Skipped: a run was still going"
                        : `Refused: ${f.message ?? ""}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
