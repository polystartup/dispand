import { CronExpressionParser } from "cron-parser";

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

function parse(cron: string, timezone: string, currentDate: Date) {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate });
}

/** Why `cron` in `timezone` can't be a schedule, for the owner, or null when it can. */
export function cronProblem(cron: string, timezone: string): string | null {
  if (cron.trim().split(/\s+/).length !== 5) return "Use 5 fields: minute hour day month weekday";
  // cron-parser picks a random minute for each parse of `H`: its fires couldn't be predicted.
  if (/h/i.test(cron)) return "Use numbers, not H";
  if (!knownTimezone(timezone)) return "Unknown timezone";
  try {
    // Parsing alone accepts dates that never come (31 February); finding the next one doesn't.
    parse(cron, timezone, new Date()).next();
    return null;
  } catch (error) {
    return `This schedule can't be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Longer than any DST change: reading fires from this far back starts before a repeated hour. */
const ANCHOR_MS = 2 * 3600_000;

/**
 * The fires strictly after `after`, read from two hours earlier. cron-parser's `next` depends on
 * where it starts: from inside a repeated hour (02:00-03:00 on the last Sunday of October in
 * Paris) it gives that hour's second pass, from before it only the first. Starting before keeps
 * every helper on the same fires, so a daily 02:30 fires once that day whatever the clock says.
 */
function* firesAfter(cron: string, timezone: string, after: Date): Generator<Date, never> {
  const it = parse(cron, timezone, new Date(after.getTime() - ANCHOR_MS));
  for (;;) {
    const fire = it.next().toDate();
    if (fire > after) yield fire;
  }
}

/** The first fire strictly after `after`. */
export function nextFireAfter(cron: string, timezone: string, after: Date): Date {
  return firesAfter(cron, timezone, after).next().value;
}

/** The next `n` fires strictly after `from`. */
export function nextFires(cron: string, timezone: string, from: Date, n: number): Date[] {
  const fires = firesAfter(cron, timezone, from);
  return Array.from({ length: n }, () => fires.next().value);
}

/**
 * The latest fire in `(since, until]`, or null when none falls there: after downtime, the one
 * time a schedule fires for (missed fires coalesce into it).
 */
export function latestFireBetween(cron: string, timezone: string, since: Date, until: Date): Date | null {
  // `prev` only finds where to look (it doesn't pick the same fires as `next` around DST changes,
  // and is strictly before its date, hence the +1 ms); the fires themselves are read forward.
  const before = parse(cron, timezone, new Date(until.getTime() + 1)).prev().toDate();
  let latest: Date | null = null;
  for (const fire of firesAfter(cron, timezone, new Date(Math.max(since.getTime(), before.getTime() - ANCHOR_MS)))) {
    if (fire > until) break;
    latest = fire;
  }
  return latest;
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
