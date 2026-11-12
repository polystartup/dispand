import { expect, test } from "vitest";
import {
  cronProblem,
  describeSchedule,
  fromCron,
  isoInZone,
  latestFireBetween,
  nextFireAfter,
  nextFires,
  scheduleTrigger,
  toCron,
  type SchedulePreset,
} from "./schedule.ts";

const PARIS = "Europe/Paris";

/** The calendar day of `date` in Paris, as "YYYY-MM-DD". */
const parisDay = (date: Date) => date.toLocaleDateString("sv-SE", { timeZone: PARIS });

test("toCron and fromCron round-trip every preset", () => {
  const presets: [SchedulePreset, string][] = [
    [{ kind: "hourly", minute: 15 }, "15 * * * *"],
    [{ kind: "daily", time: "09:00" }, "0 9 * * *"],
    [{ kind: "weekdays", time: "18:45" }, "45 18 * * 1-5"],
    [{ kind: "weekly", weekday: 1, time: "08:30" }, "30 8 * * 1"],
    [{ kind: "weekly", weekday: 0, time: "00:00" }, "0 0 * * 0"],
    [{ kind: "monthly", day: 28, time: "23:59" }, "59 23 28 * *"],
  ];
  for (const [preset, cron] of presets) {
    expect(toCron(preset)).toBe(cron);
    expect(fromCron(cron)).toEqual(preset);
  }
});

test("fromCron leaves anything else to Custom", () => {
  for (const cron of ["*/5 * * * *", "0 9 * * 1-3", "0 9 31 * *", "0 9 1 1 *", "00 9 * * *", "0 9 * * 7", "@daily", "0 0 9 * * *"]) {
    expect(fromCron(cron)).toBeNull();
  }
});

test("cronProblem refuses 6 fields and unknown timezones", () => {
  expect(cronProblem("0 9 * * 1-5", PARIS)).toBeNull();
  expect(cronProblem("0 0 9 * * *", PARIS)).toBe("Use 5 fields: minute hour day month weekday");
  expect(cronProblem("@daily", PARIS)).toBe("Use 5 fields: minute hour day month weekday");
  expect(cronProblem("H 9 * * *", PARIS)).toBe("Use numbers, not H");
  expect(cronProblem("0 9 * * *", "Mars/Olympus")).toBe("Unknown timezone");
  expect(cronProblem("0 9 * * *", "")).toBe("Unknown timezone");
  expect(cronProblem("61 9 * * *", PARIS)).toMatch(/^This schedule can't be read/);
  expect(cronProblem("0 0 30 2 *", PARIS)).toMatch(/^This schedule can't be read/);
});

test("schedules read in UTC", () => {
  // Intl.supportedValuesOf("timeZone") lists neither.
  for (const zone of ["UTC", "Etc/UTC"]) {
    expect(cronProblem("0 9 * * 1-5", zone)).toBeNull();
    expect(nextFireAfter("0 9 * * *", zone, new Date("2026-11-04T09:30:00Z"))).toEqual(new Date("2026-11-05T09:00:00Z"));
    // Paris's autumn change is no change in UTC: one fire a day, at 09:00Z.
    expect(nextFires("0 9 * * *", zone, new Date("2027-10-30T12:00:00Z"), 2)).toEqual([new Date("2027-10-31T09:00:00Z"), new Date("2027-11-01T09:00:00Z")]);
    expect(latestFireBetween("0 9 * * *", zone, new Date("2027-10-29T00:00:00Z"), new Date("2027-10-31T12:00:00Z"))).toEqual(new Date("2027-10-31T09:00:00Z"));
    expect(isoInZone(new Date("2026-11-05T09:00:00Z"), zone)).toBe("2026-11-05T09:00:00+00:00");
  }
});

test("nextFireAfter in Europe/Paris", () => {
  expect(nextFireAfter("0 9 * * *", PARIS, new Date("2026-11-04T08:30:00Z"))).toEqual(new Date("2026-11-05T08:00:00Z"));
  // Strictly after: a fire at the given instant is not the next one.
  expect(nextFireAfter("0 9 * * *", PARIS, new Date("2026-11-05T08:00:00Z"))).toEqual(new Date("2026-11-06T08:00:00Z"));
});

test("fires once per day across DST", () => {
  // 2027-10-31: 02:30 happens twice in Paris (CEST, then CET). One fire, on the first.
  const autumn = nextFires("30 2 * * *", PARIS, new Date("2027-10-29T23:00:00Z"), 3);
  expect(autumn.map(parisDay)).toEqual(["2027-10-30", "2027-10-31", "2027-11-01"]);
  expect(autumn[1]).toEqual(new Date("2027-10-31T00:30:00Z"));
  // 2027-03-28: 02:30 doesn't exist in Paris. At most one fire; cron-parser moves it to 03:30 CEST.
  const spring = nextFires("30 2 * * *", PARIS, new Date("2027-03-26T23:00:00Z"), 3);
  expect(spring.filter((d) => parisDay(d) === "2027-03-28").length).toBeLessThanOrEqual(1);
  expect(spring.map(parisDay)).toEqual(["2027-03-27", "2027-03-28", "2027-03-29"]);
  expect(spring[1]).toEqual(new Date("2027-03-28T01:30:00Z"));
});

test("latestFireBetween coalesces", () => {
  const at = (time: string) => new Date(`2026-11-05T${time}:00+01:00`);
  expect(latestFireBetween("0 * * * *", PARIS, at("10:05"), at("13:20"))).toEqual(at("13:00"));
  // `until` is included, `since` is not.
  expect(latestFireBetween("0 * * * *", PARIS, at("10:05"), at("13:00"))).toEqual(at("13:00"));
  expect(latestFireBetween("0 * * * *", PARIS, at("13:00"), at("13:20"))).toBeNull();
  expect(latestFireBetween("0 * * * *", PARIS, at("13:05"), at("13:20"))).toBeNull();
});

test("every helper picks the same fires across DST", () => {
  const z = (iso: string) => new Date(iso);
  // 2027-10-31: the repeated 02:30 fires on its first pass (00:30Z) only.
  expect(latestFireBetween("30 2 * * *", PARIS, z("2027-10-31T00:31:00Z"), z("2027-10-31T01:31:00Z"))).toBeNull();
  expect(latestFireBetween("30 2 * * *", PARIS, z("2027-10-30T12:00:00Z"), z("2027-10-31T01:31:00Z"))).toEqual(z("2027-10-31T00:30:00Z"));
  // From inside the repeated hour, the next fire is the next day's.
  expect(nextFireAfter("30 2 * * *", PARIS, z("2027-10-31T01:10:00Z"))).toEqual(z("2027-11-01T01:30:00Z"));
  // 2027-03-28: the missing 02:30 fires at 03:30 CEST (01:30Z), as `nextFires` says.
  expect(latestFireBetween("30 2 * * *", PARIS, z("2027-03-27T12:00:00Z"), z("2027-03-28T01:31:00Z"))).toEqual(z("2027-03-28T01:30:00Z"));
});

test("describeSchedule names presets and the timezone when it isn't Paris", () => {
  expect(describeSchedule("0 9 * * 1-5", PARIS)).toBe("Every weekday at 09:00");
  expect(describeSchedule("15 * * * *", PARIS)).toBe("Every hour at :15");
  expect(describeSchedule("0 9 * * *", PARIS)).toBe("Every day at 09:00");
  expect(describeSchedule("30 8 * * 1", PARIS)).toBe("Every Monday at 08:30");
  expect(describeSchedule("0 7 5 * *", PARIS)).toBe("Every month on day 5 at 07:00");
  expect(describeSchedule("*/5 * * * *", PARIS)).toBe("Custom: */5 * * * *");
  expect(describeSchedule("0 9 * * *", "America/New_York")).toBe("Every day at 09:00 (America/New_York)");
});

test("scheduleTrigger is weekdays at 09:00 in Paris", () => {
  expect(scheduleTrigger("n_trigger")).toEqual({
    type: "schedule",
    field: { id: "n_trigger", key: "schedule", type: "schedule", label: "Schedule", cron: "0 9 * * 1-5", timezone: PARIS },
  });
});

test("isoInZone writes the time with the timezone's offset", () => {
  expect(isoInZone(new Date("2026-11-05T08:00:00Z"), PARIS)).toBe("2026-11-05T09:00:00+01:00");
  expect(isoInZone(new Date("2027-07-01T07:30:15Z"), PARIS)).toBe("2027-07-01T09:30:15+02:00");
  expect(isoInZone(new Date("2026-11-05T08:00:00Z"), "Asia/Kolkata")).toBe("2026-11-05T13:30:00+05:30");
  expect(isoInZone(new Date("2026-11-05T08:00:00Z"), "America/New_York")).toBe("2026-11-05T03:00:00-05:00");
});
