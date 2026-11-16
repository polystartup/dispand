import { say } from "@dispand/domain/messages/index.ts";
import type { ScheduleField } from "@dispand/domain/workflows/model";
import { cronProblem, DEFAULT_TIMEZONE, fromCron, knownTimezone, nextFires, toCron, type SchedulePreset } from "@dispand/domain/workflows/schedule";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { useText } from "@/lib/message";
import { useFormat } from "../../../lib/format.ts";
import { cn } from "@/lib/utils";
import { FormField } from "../../settings/parts.tsx";
import { selectClass } from "../../data/NewFieldPopover.tsx";

/** One fire of the schedule, as `workflows.get` gives it. */
export type ScheduleFire = { scheduledFor: Date; status: "started" | "skipped-overlap" | "refused"; runId: string | null; message: string | null };

type Kind = SchedulePreset["kind"] | "custom";
const KINDS: Kind[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];
/** Monday first, as the owner's week. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

let zones: string[] | undefined;
function timezones(): string[] {
  return (zones ??= Intl.supportedValuesOf("timeZone"));
}

/** A date as "Thu 5 Nov, 09:00" in `timezone`, in the page's language. */
export function useAt() {
  const format = useFormat();
  return (date: Date, timezone: string) => format.dateTime(date, { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** The schedule in words: "Every weekday at 09:00"; the timezone named when it isn't Paris. */
export function useDescribeSchedule() {
  const { t } = useTranslation("workflows");
  return (cron: string, timezone: string): string => {
    const p = fromCron(cron);
    const pad = (n: number) => String(n).padStart(2, "0");
    const text = !p
      ? t("describeSchedule.custom", { cron: cron.trim() })
      : p.kind === "hourly"
        ? t("describeSchedule.hourly", { minute: pad(p.minute) })
        : p.kind === "weekly"
          ? t("describeSchedule.weekly", { weekday: t(`schedule.weekday.${p.weekday}`), time: p.time })
          : p.kind === "monthly"
            ? t("describeSchedule.monthly", { day: p.day, time: p.time })
            : t(`describeSchedule.${p.kind}`, { time: p.time });
    return timezone === DEFAULT_TIMEZONE ? text : t("describeSchedule.zone", { text, timezone });
  };
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
  const { t } = useTranslation("workflows");
  const at = useAt();
  const ids = { cron: useId(), tz: useId(), zones: useId(), problem: useId() };
  const preset = fromCron(field.cron);
  const [kind, setKind] = useState<Kind>(preset?.kind ?? "custom");
  // What is typed, kept while it can't be saved.
  const [cron, setCron] = useState(field.cron);
  const [timezone, setTimezone] = useState(field.timezone);
  const text = useText();
  const cronIssue = kind === "custom" ? cronProblem(cron, field.timezone) : null;
  const tzIssue = knownTimezone(timezone) ? null : say("workflows.schedule.unknownTimezone");

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
        <p className="mb-1.5 text-[13px] font-medium text-muted">{t("schedule.repeat")}</p>
        <div role="radiogroup" aria-label={t("schedule.repeat")} className="grid grid-cols-2 gap-1 rounded-xl bg-active p-1 sm:grid-cols-3">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => pick(k)}
              className={cn("rounded-lg py-1.5 text-[13px] font-medium transition", kind === k ? "bg-surface shadow-card" : "text-muted hover:text-fg")}
            >
              {t(`schedule.kind.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {shown?.kind === "hourly" && (
        <FormField label={t("schedule.minute")} htmlFor="schedule-minute" hint={t("schedule.minuteHint")}>
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
        <FormField label={t("schedule.day")} htmlFor="schedule-weekday">
          <select id="schedule-weekday" value={shown.weekday} onChange={(e) => setPreset({ ...shown, weekday: Number(e.target.value) as typeof shown.weekday })} className={selectClass}>
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {t(`schedule.weekday.${d}`)}
              </option>
            ))}
          </select>
        </FormField>
      )}
      {shown?.kind === "monthly" && (
        <FormField label={t("schedule.dayOfMonth")} htmlFor="schedule-day" hint={t("schedule.dayOfMonthHint")}>
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
        <FormField label={t("schedule.time")} htmlFor="schedule-time">
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
        <FormField label={t("schedule.cron")} htmlFor={ids.cron} hint={t("schedule.cronHint")}>
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
              {text(cronIssue)}
            </p>
          )}
        </FormField>
      )}

      <FormField label={t("schedule.timezone")} htmlFor={ids.tz}>
        <Input
          id={ids.tz}
          value={timezone}
          maxLength={64}
          list={ids.zones}
          aria-invalid={tzIssue !== null}
          onChange={(e) => {
            setTimezone(e.target.value);
            if (knownTimezone(e.target.value)) save({ timezone: e.target.value });
          }}
        />
        <datalist id={ids.zones}>
          {timezones().map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        {tzIssue && (
          <p role="alert" className="mt-1.5 text-[13px] text-danger">
            {text(tzIssue)}
          </p>
        )}
      </FormField>

      {next.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">{t("schedule.nextRuns", { timezone: field.timezone })}</p>
          <ul aria-label={t("schedule.nextRunsList")} className="space-y-1 text-[14px]">
            {next.map((d) => (
              <li key={d.getTime()}>{at(d, field.timezone)}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex items-center justify-between gap-3 text-[14px]">
        <span>
          {t("schedule.paused")}
          {!schedule && <span className="block text-[12px] text-faint">{t("schedule.pausedHint")}</span>}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t("schedule.paused")}
          disabled={!schedule}
          checked={schedule ? !schedule.enabled : false}
          onChange={(e) => onPause(!e.target.checked)}
          className="size-4 accent-[var(--color-accent)]"
        />
      </label>

      {fires.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">{t("schedule.recent")}</p>
          <ul aria-label={t("schedule.recent")} className="space-y-1.5 text-[14px]">
            {fires.map((f) => (
              <li key={f.scheduledFor.getTime()} className="flex flex-wrap justify-between gap-x-3">
                <span className="text-muted">{at(f.scheduledFor, field.timezone)}</span>
                <span className={f.status === "refused" ? "text-danger" : undefined}>
                  {f.status === "started" && f.runId
                    ? runLink(f.runId, t("schedule.started"))
                    : f.status === "started"
                      ? t("schedule.started")
                      : f.status === "skipped-overlap"
                        ? t("schedule.skippedOverlap")
                        : t("schedule.refused", { message: f.message ?? "" })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
