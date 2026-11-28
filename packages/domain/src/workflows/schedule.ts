import { Cron } from "croner";
import { type Message, say } from "../messages/index.ts";

// Pure: imported by the web editor too (`@dispand/domain/workflows/schedule`).

/** Where a new schedule's times are read, and the one the editor doesn't name. */
export const DEFAULT_TIMEZONE = "Europe/Paris";

/** What a schedule trigger gives the steps after it. */
export const SCHEDULE_OUTPUTS = ["scheduled_for"] as const;

/** The schedules the picker offers; `time` is "HH:MM" (24 h). Any other cron is Custom. */
export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; time: string }
  | { kind: "monthly"; day: number; time: string };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * Whether schedules can be read in `timezone`: any zone `Intl.DateTimeFormat` takes, `UTC` and
 * `Etc/UTC` included (`Intl.supportedValuesOf` lists neither).
 */
export function knownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Each field's last value as cron-parser read it (day-of-week's 7 is Sunday too), and the longest step croner takes. */
const LAST = [59, 23, 31, 12, 7];
const LONGEST_STEP = [60, 24, 31, 12, 7];
/** Month and weekday names, numbered as cron-parser did: January 1, Sunday 0 (croner reads a range's last SUN as 7). */
const NAMES = [
  [],
  [],
  [],
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
];

/**
 * `cron` written so croner reads it as cron-parser, which read schedules before it, did: names
 * as its numbers (`SUN-SUN` is Sunday alone), a step from one value runs to the field's end
 * (`5/15` is `5-59/15`, and day-of-week ends at 7, Sunday), and a step longer than its field keeps
 * only its start (every 100 hours is midnight), which croner refuses.
 */
function asSaved(cron: string): string {
  return cron
    .trim()
    .split(/\s+/)
    .map((field, i) =>
      field
        .replace(/[a-z]{3}/gi, (name) => {
          const n = NAMES[i]!.indexOf(name.toLowerCase());
          return n < 0 ? name : String(i === 3 ? n + 1 : n);
        })
        .replace(/([^,/]+)\/(\d+)/g, (_, from: string, step: string) => {
          const range = from === "*" || from === "?" || from.includes("-") ? from : `${from}-${LAST[i]}`;
          return `${range}/${Math.min(Number(step), LONGEST_STEP[i]!)}`;
        }),
    )
    .join(" ");
}

/**
 * How croner reads `cron` in `timezone`, in that zone's wall clock. A time a DST change repeats
 * fires once, on its first pass. A time a change skips fires once at the end of the gap (a daily
 * 02:30 at 03:00 in Paris), that day: a gap that runs to midnight (Nuuk's, from 23:00) skips it,
 * as cron-parser did. Unless the cron gives its minute or hour as `*` or a step (every 15
 * minutes, an hourly `15 * * * *`): that is an interval, in real time, firing on both passes of a
 * repeated hour and never in a skipped one.
 */
function read(cron: string, timezone: string): Cron {
  // croner keeps a formatter for each spelling of a zone (`europe/paris`), for good: give it the canonical one.
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  return new Cron(asSaved(cron), { timezone: zone, mode: "5-part", fixedTimeRule: "no-wildcard" });
}

/** Why `cron` in `timezone` can't be a schedule, for the owner, or null when it can. */
export function cronProblem(cron: string, timezone: string): Message | null {
  // croner reads a colon as a one-time date ("Jan 1 2030 00:00"), never a cron.
  if (cron.trim().split(/\s+/).length !== 5 || cron.includes(":")) return say("workflows.schedule.fields");
  // Jenkins' `H` (a minute picked per job) isn't cron: croner refuses it, said plainly here.
  if (/h/i.test(cron)) return say("workflows.schedule.noH");
  if (!knownTimezone(timezone)) return say("workflows.schedule.unknownTimezone");
  try {
    // Parsing alone accepts dates that never come (31 February); finding the next one doesn't.
    nextFireAfter(cron, timezone, new Date());
    return null;
  } catch (error) {
    return say("workflows.schedule.unreadable", { reason: error instanceof Error ? error.message : String(error) });
  }
}

/** The first fire strictly after `after`. */
export function nextFireAfter(cron: string, timezone: string, after: Date): Date {
  const next = read(cron, timezone).nextRun(after);
  if (!next) throw new Error("it never fires");
  return next;
}

/** The next `n` fires strictly after `from`. */
export function nextFires(cron: string, timezone: string, from: Date, n: number): Date[] {
  return read(cron, timezone).nextRuns(n, from);
}

/**
 * The latest fire in `(since, until]`, or null when none falls there: after downtime, the one
 * time a schedule fires for (missed fires coalesce into it).
 */
export function latestFireBetween(cron: string, timezone: string, since: Date, until: Date): Date | null {
  // `previousRuns` is strictly before its date, hence the +1 ms.
  const [latest] = read(cron, timezone).previousRuns(1, new Date(until.getTime() + 1));
  return latest && latest > since ? latest : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `date` as ISO 8601 in `timezone`, with its offset: "2026-11-05T09:00:00+01:00" (what `scheduled_for` gives). */
export function isoInZone(date: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const wall = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  // The offset is how far the wall clock is from UTC, to the minute.
  const offset = Math.round((Date.parse(`${wall}Z`) - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  return `${wall}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
/** A cron number in its plain form (no leading zero), so presets round-trip exactly. */
const NUMBER = /^(0|[1-9][0-9]?)$/;

function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

export function toCron(p: SchedulePreset): string {
  if (p.kind === "hourly") return `${p.minute} * * * *`;
  const { hour, minute } = parseTime(p.time);
  switch (p.kind) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${p.weekday}`;
    case "monthly":
      return `${minute} ${hour} ${p.day} * *`;
  }
}

/** The preset `cron` is, or null when the picker shows it as Custom. */
export function fromCron(cron: string): SchedulePreset | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, month, dow] = parts as [string, string, string, string, string];
  const num = (s: string, max: number, min = 0) => (NUMBER.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null);
  const minute = num(m, 59);
  if (minute === null || month !== "*") return null;
  if (h === "*" && dom === "*" && dow === "*") return { kind: "hourly", minute };
  const hour = num(h, 23);
  if (hour === null) return null;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (dom === "*" && dow === "*") return { kind: "daily", time };
  if (dom === "*" && dow === "1-5") return { kind: "weekdays", time };
  const weekday = dom === "*" ? num(dow, 6) : null;
  if (weekday !== null) return { kind: "weekly", weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6, time };
  const day = dow === "*" ? num(dom, 28, 1) : null;
  if (day !== null) return { kind: "monthly", day, time };
  return null;
}

/** The schedule in words: "Every weekday at 09:00"; the timezone named when it isn't Paris. */
export function describeSchedule(cron: string, timezone: string): string {
  const p = fromCron(cron);
  const text = (() => {
    switch (p?.kind) {
      case undefined:
        return `Custom: ${cron.trim()}`;
      case "hourly":
        return `Every hour at :${pad(p.minute)}`;
      case "daily":
        return `Every day at ${p.time}`;
      case "weekdays":
        return `Every weekday at ${p.time}`;
      case "weekly":
        return `Every ${WEEKDAYS[p.weekday]} at ${p.time}`;
      case "monthly":
        return `Every month on day ${p.day} at ${p.time}`;
    }
  })();
  return timezone === DEFAULT_TIMEZONE ? text : `${text} (${timezone})`;
}

/** A new schedule trigger: weekdays at 09:00, Paris time. */
export function scheduleTrigger(id: string) {
  return {
    type: "schedule" as const,
    field: { id, key: "schedule", type: "schedule" as const, label: "Schedule", cron: "0 9 * * 1-5", timezone: DEFAULT_TIMEZONE },
  };
}
