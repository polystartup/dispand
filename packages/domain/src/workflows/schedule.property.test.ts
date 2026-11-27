import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { cronProblem, fromCron, isoInZone, knownTimezone, latestFireBetween, nextFireAfter, nextFires, toCron, type SchedulePreset } from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const pad = (n: number) => String(n).padStart(2, "0");

/** Every zone `Intl.supportedValuesOf` lists, and often the two UTC names it lists neither of. */
const allZones = fc.oneof(fc.constantFrom("UTC", "Etc/UTC"), fc.constantFrom(...Intl.supportedValuesOf("timeZone")));
// Zones with DST changes north and south, and zones without. Narrower than the claims, which hold
// for every zone: cron-parser mis-reads some zones' changes today (#616), so these leave out Lord
// Howe and Chatham (changes off the hour), Havana and Santiago (at midnight) and Troll (two hours).
const ZONES = ["Europe/Paris", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "UTC"];
/** Their 2027 DST changes, each with its zone, so fires around them come up often. */
const CHANGES: [string, string][] = [
  ["Europe/Paris", "2027-03-28T01:00Z"],
  ["Europe/Paris", "2027-10-31T01:00Z"],
  ["America/New_York", "2027-03-14T07:00Z"],
  ["America/New_York", "2027-11-07T06:00Z"],
  ["Australia/Sydney", "2027-04-03T16:00Z"],
  ["Australia/Sydney", "2027-10-02T16:00Z"],
];

/** On the minute half the time, as fires are. */
const millis = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: MINUTE - 1 }));
/** A zone and a date: hours or days before one of its DST changes, or any date of a few years. */
const zoned = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .tuple(fc.constantFrom(...CHANGES), fc.oneof(fc.integer({ min: -6 * 60, max: 60 }), fc.integer({ min: -2 * 24 * 60, max: 24 * 60 })), millis)
      .map(([[zone, change], minutes, ms]) => ({ zone, date: new Date(Date.parse(change) + minutes * MINUTE + ms) })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom(...ZONES), fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2031, 0, 1) }))
      .map(([zone, t]) => ({ zone, date: new Date(t) })),
  },
);

// DST changes happen at night: hours 0-3 come up often.
const time = fc
  .tuple(fc.oneof(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 3 })), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${pad(h)}:${pad(m)}`);
const presets: fc.Arbitrary<SchedulePreset> = fc.oneof(
  fc.record({ kind: fc.constant("hourly" as const), minute: fc.integer({ min: 0, max: 59 }) }),
  fc.record({ kind: fc.constantFrom("daily" as const, "weekdays" as const), time }),
  fc.record({
    kind: fc.constant("weekly" as const),
    weekday: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const, 4 as const, 5 as const, 6 as const),
    time,
  }),
  fc.record({ kind: fc.constant("monthly" as const), day: fc.integer({ min: 1, max: 28 }), time }),
);
/** Presets, and crons that fire often or inside the hours DST changes (02:30 repeats in Paris and Sydney, 01:30 in New York). */
const crons = fc.oneof(
  presets.map(toCron),
  fc.constantFrom("*/15 * * * *", "0 */2 * * *", "0,30 1-3 * * *", "45 2 * * 0", "30 2 * * *", "30 1 * * *", "15 0 1,15 * *", "30 23 * * 6"),
);

// Fixed seeds and few runs: the same inputs on every run, so a merge queue never meets a new one.

// schedule.ts "so presets round-trip exactly"; "The schedules the picker offers" and "or null when it can"; "`UTC` and `Etc/UTC` included".
test("every preset round-trips through toCron and fromCron, and is a schedule in any zone", () => {
  // cronProblem looks for the next fire from now (schedule.ts): a fixed now, the same answers
  // every day. Near some zones' DST changes it calls presets unreadable (Lord Howe on 2027-04-03).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
  try {
    fc.assert(
      fc.property(presets, allZones, (preset, zone) => {
        expect(fromCron(toCron(preset))).toEqual(preset);
        expect(knownTimezone(zone)).toBe(true);
        expect(cronProblem(toCron(preset), zone)).toBeNull();
      }),
      { seed: 701, numRuns: 150 },
    );
  } finally {
    vi.useRealTimers();
  }
});

// schedule.ts "A cron number in its plain form (no leading zero), so presets round-trip exactly"; "The schedules the picker offers"; schedule.test.ts "00 9 * * *" is Custom.
test("fromCron reads as a preset only a schedule toCron writes back the same", () => {
  // A preset's cron with its fields changed for near misses, so many still read as presets. Single
  // spaces only: fromCron reads any whitespace between fields, which toCron doesn't write back.
  const nearMiss = (field: string) =>
    fc.oneof(
      { weight: 4, arbitrary: fc.constant(field) },
      fc.constantFrom(`0${field}`, `+${field}`, `${field}.0`, `${field},${field}`, "*", "1-5", "7", "24", "29", "60"),
      fc.integer({ min: 0, max: 99 }).map(String),
    );
  const near = presets.chain((preset) => fc.tuple(...toCron(preset).split(" ").map(nearMiss)));
  fc.assert(
    fc.property(near, (fields) => {
      const cron = fields.join(" ");
      const preset = fromCron(cron);
      if (preset === null) return;
      expect(toCron(preset)).toBe(cron);
      // Out-of-range numbers (24, 60) write back the same too: they must stay Custom.
      expect(cronProblem(cron, "UTC")).toBeNull();
    }),
    { seed: 702, numRuns: 2_000 },
  );
});

// schedule.ts "The first fire strictly after `after`"; "The next `n` fires strictly after `from`"; "Starting before keeps every helper on the same fires".
test("nextFires are strictly increasing, and nextFireAfter of any date gives the next of them", () => {
  fc.assert(
    fc.property(crons, zoned, fc.integer({ min: 0, max: HOUR - 1 }), fc.integer({ min: 0, max: 999_999 }), (cron, { zone, date: from }, delay, at) => {
      const fires = nextFires(cron, zone, from, 4);
      expect(fires[0]).toEqual(nextFireAfter(cron, zone, from));
      expect(fires[0]!.getTime()).toBeGreaterThan(from.getTime());
      for (let i = 0; i + 1 < fires.length; i++) {
        expect(fires[i + 1]!.getTime()).toBeGreaterThan(fires[i]!.getTime());
        expect(nextFireAfter(cron, zone, fires[i]!)).toEqual(fires[i + 1]);
        // Up to an hour after a fire, as a late tick asks: the second pass of a repeated hour included.
        const late = new Date(Math.min(fires[i]!.getTime() + delay, fires[i + 1]!.getTime() - 1));
        expect(nextFireAfter(cron, zone, late)).toEqual(fires[i + 1]);
      }
      // Any date from `from` to before the last fire: its next fire is the first of them after it.
      const after = new Date(from.getTime() + Math.floor((at / 1_000_000) * (fires.at(-1)!.getTime() - from.getTime())));
      expect(nextFireAfter(cron, zone, after)).toEqual(fires.find((f) => f > after));
    }),
    { seed: 703, numRuns: 80 },
  );
});

// schedule.ts "The latest fire in `(since, until]`, or null when none falls there".
test("latestFireBetween is the last fire in (since, until], or null when none falls there", () => {
  const spans = fc.tuple(fc.integer({ min: -60, max: 3 * 24 * 60 }), millis).map(([minutes, ms]) => minutes * MINUTE + ms);
  fc.assert(
    fc.property(crons, zoned, spans, fc.integer({ min: 0, max: 7 }), (cron, { zone, date: since }, span, k) => {
      // Half the time `until` is a fire itself, which the `]` includes.
      const until = k < 4 ? nextFires(cron, zone, since, k + 1)[k]! : new Date(since.getTime() + span);
      const latest = latestFireBetween(cron, zone, since, until);
      if (latest === null) {
        expect(nextFireAfter(cron, zone, since).getTime()).toBeGreaterThan(until.getTime());
        return;
      }
      expect(latest.getTime()).toBeGreaterThan(since.getTime());
      expect(latest.getTime()).toBeLessThanOrEqual(until.getTime());
      // A fire, and the last one: the next one is after `until`.
      expect(nextFireAfter(cron, zone, new Date(latest.getTime() - 1))).toEqual(latest);
      expect(nextFireAfter(cron, zone, latest).getTime()).toBeGreaterThan(until.getTime());
    }),
    { seed: 704, numRuns: 100 },
  );
});

// schedule.ts "a daily 02:30 fires once that day"; "Every weekday at 09:00", in the timezone named; schedule.test.ts "fires once per day across DST".
test("a daily schedule fires once on each day at its time, across DST changes", () => {
  fc.assert(
    fc.property(time, zoned, (at, { zone, date: from }) => {
      const fires = nextFires(toCron({ kind: "daily", time: at }), zone, from, 4);
      const days = fires.map((d) => Date.parse(d.toLocaleDateString("sv-SE", { timeZone: zone })));
      for (let i = 0; i + 1 < days.length; i++) expect(days[i + 1]! - days[i]!).toBe(DAY);
      // At its time in the zone, but on the one day a DST change may skip it.
      const onTime = fires.filter((d) => d.toLocaleTimeString("sv-SE", { timeZone: zone, hour: "2-digit", minute: "2-digit" }) === at);
      expect(onTime.length).toBeGreaterThanOrEqual(3);
    }),
    { seed: 705, numRuns: 100 },
  );
});

// schedule.ts "`date` as ISO 8601 in `timezone`, with its offset"; from 1973, as gives the offset "to the minute" and some zones' had seconds until 1972.
test("isoInZone writes the zone's wall clock in ISO 8601, with an offset that reads back to the same second", () => {
  fc.assert(
    fc.property(fc.integer({ min: Date.UTC(1973, 0, 1), max: Date.UTC(2100, 0, 1) }), allZones, (t, zone) => {
      const iso = isoInZone(new Date(t), zone);
      expect(iso).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
      expect(Date.parse(iso)).toBe(Math.floor(t / 1000) * 1000);
      // The offset alone can't tell the zone: UTC's wall clock with +00:00 reads back the same.
      expect(iso.slice(0, 19)).toBe(new Date(t).toLocaleString("sv-SE", { timeZone: zone }).replace(" ", "T"));
    }),
    { seed: 706, numRuns: 1_000 },
  );
});
