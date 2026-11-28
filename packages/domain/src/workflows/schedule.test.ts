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
  expect(cronProblem("0 0 9 * * *", PARIS)).toEqual({ key: "workflows.schedule.fields" });
  expect(cronProblem("@daily", PARIS)).toEqual({ key: "workflows.schedule.fields" });
  // Five words croner would read as one date.
  expect(cronProblem("Jan 1 2030 00:00:00 +0000", PARIS)).toEqual({ key: "workflows.schedule.fields" });
  expect(cronProblem("H 9 * * *", PARIS)).toEqual({ key: "workflows.schedule.noH" });
  expect(cronProblem("0 9 * * *", "Mars/Olympus")).toEqual({ key: "workflows.schedule.unknownTimezone" });
  expect(cronProblem("0 9 * * *", "")).toEqual({ key: "workflows.schedule.unknownTimezone" });
  expect(cronProblem("61 9 * * *", PARIS)).toMatchObject({ key: "workflows.schedule.unreadable" });
  expect(cronProblem("0 0 30 2 *", PARIS)).toMatchObject({ key: "workflows.schedule.unreadable" });
  expect(cronProblem("0 9 * * SAT-SUN", PARIS)).toMatchObject({ key: "workflows.schedule.unreadable" });
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

test("a timezone reads the same however it is spelled", () => {
  const after = new Date("2026-11-04T08:30:00Z");
  expect(nextFireAfter("0 9 * * *", "europe/PARIS", after)).toEqual(nextFireAfter("0 9 * * *", PARIS, after));
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
  // 2027-03-28: 02:30 doesn't exist in Paris. One fire, at the end of the gap: 03:00 CEST.
  const spring = nextFires("30 2 * * *", PARIS, new Date("2027-03-26T23:00:00Z"), 3);
  expect(spring.filter((d) => parisDay(d) === "2027-03-28").length).toBeLessThanOrEqual(1);
  expect(spring.map(parisDay)).toEqual(["2027-03-27", "2027-03-28", "2027-03-29"]);
  expect(spring[1]).toEqual(new Date("2027-03-28T01:00:00Z"));
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
  // 2027-03-28: the missing 02:30 fires at 03:00 CEST (01:00Z), as `nextFires` says.
  expect(latestFireBetween("30 2 * * *", PARIS, z("2027-03-27T12:00:00Z"), z("2027-03-28T01:31:00Z"))).toEqual(z("2027-03-28T01:00:00Z"));
  expect(latestFireBetween("30 2 * * *", PARIS, z("2027-03-28T01:00:00Z"), z("2027-03-28T23:00:00Z"))).toBeNull();
});

test("a cron with `*` or a step in its minute or hour fires in real time across DST", () => {
  const z = (iso: string) => new Date(iso);
  // 2027-10-31: Paris's 02:00-03:00 comes twice. An hourly fires in both, every two hours too.
  expect(nextFires("15 * * * *", PARIS, z("2027-10-30T23:30:00Z"), 3)).toEqual([
    z("2027-10-31T00:15:00Z"),
    z("2027-10-31T01:15:00Z"),
    z("2027-10-31T02:15:00Z"),
  ]);
  expect(nextFires("0 */2 * * *", PARIS, z("2027-10-30T23:30:00Z"), 3)).toEqual([
    z("2027-10-31T00:00:00Z"),
    z("2027-10-31T01:00:00Z"),
    z("2027-10-31T03:00:00Z"),
  ]);
  // A time named in a list or range fires once, as a daily one does.
  expect(nextFires("30 2,14 * * *", PARIS, z("2027-10-30T23:30:00Z"), 2)).toEqual([z("2027-10-31T00:30:00Z"), z("2027-10-31T13:30:00Z")]);
  // 2027-03-28: 02:00-03:00 never comes. An hourly skips it; times named in it fire once, at 03:00.
  expect(nextFires("15 * * * *", PARIS, z("2027-03-27T23:30:00Z"), 2)).toEqual([z("2027-03-28T00:15:00Z"), z("2027-03-28T01:15:00Z")]);
  expect(nextFires("0,30 1-3 * * *", PARIS, z("2027-03-27T23:30:00Z"), 4)).toEqual([
    z("2027-03-28T00:00:00Z"),
    z("2027-03-28T00:30:00Z"),
    z("2027-03-28T01:00:00Z"),
    z("2027-03-28T01:30:00Z"),
  ]);
});

// #616: cron-parser threw on these, fired twice, or picked a pass by where it started reading.
test("reads DST changes off the hour, at midnight and of two hours", () => {
  const z = (iso: string) => new Date(iso);
  // Lord Howe goes back half an hour at 02:00 on 2027-04-04: 09:00 is 22:30Z that day.
  expect(nextFireAfter("0 9 * * *", "Australia/Lord_Howe", z("2027-04-03T00:00:00Z"))).toEqual(z("2027-04-03T22:30:00Z"));
  // Chatham goes back an hour at 03:45 (+13:45) on 2027-04-04: an hourly :44 fires every hour,
  // and a Sunday 02:45, which comes twice, on its first pass.
  expect(nextFires("44 * * * *", "Pacific/Chatham", z("2027-04-03T12:00:00Z"), 4)).toEqual([
    z("2027-04-03T12:59:00Z"),
    z("2027-04-03T13:59:00Z"),
    z("2027-04-03T14:59:00Z"),
    z("2027-04-03T15:59:00Z"),
  ]);
  expect(nextFires("45 2 * * 0", "Pacific/Chatham", z("2027-04-01T00:00:00Z"), 2)).toEqual([z("2027-04-03T13:00:00Z"), z("2027-04-10T14:00:00Z")]);
  // Santiago skips midnight on 2027-09-05: that day's 00:00 fires at 01:00 (-03:00).
  expect(latestFireBetween("0 0 * * *", "America/Santiago", z("2027-09-04T12:00:00Z"), z("2027-09-06T02:45:00Z"))).toEqual(z("2027-09-05T04:00:00Z"));
  expect(nextFires("0 0 * * *", "America/Santiago", z("2027-09-04T12:00:00Z"), 2)).toEqual([z("2027-09-05T04:00:00Z"), z("2027-09-06T03:00:00Z")]);
  // Havana's midnight hour comes twice on 2026-11-01: 00:15 fires on its first pass (-04:00) only, from any start.
  const havana = "15 0 1,15 * *";
  expect(nextFires(havana, "America/Havana", z("2026-08-15T12:00:00Z"), 6).slice(4)).toEqual([z("2026-11-01T04:15:00Z"), z("2026-11-15T05:15:00Z")]);
  expect(nextFireAfter(havana, "America/Havana", z("2026-11-01T04:15:00Z"))).toEqual(z("2026-11-15T05:15:00Z"));
  expect(latestFireBetween(havana, "America/Havana", z("2026-10-15T12:00:00Z"), z("2026-11-01T04:15:05Z"))).toEqual(z("2026-11-01T04:15:00Z"));
  expect(latestFireBetween(havana, "America/Havana", z("2026-11-01T04:16:00Z"), z("2026-11-01T05:30:00Z"))).toBeNull();
  // Troll goes back two hours on 2027-10-31 (01:00-03:00 comes twice): one 02:30 a day, the first pass.
  expect(nextFires("30 2 * * *", "Antarctica/Troll", z("2027-10-29T00:00:00Z"), 4)).toEqual([
    z("2027-10-29T00:30:00Z"),
    z("2027-10-30T00:30:00Z"),
    z("2027-10-31T00:30:00Z"),
    z("2027-11-01T02:30:00Z"),
  ]);
});

test("reads the crons it accepts as before: steps, L, #, ? and names", () => {
  // Pinned from cron-parser, which read schedules until #616. A step from one value runs to the
  // field's end (Sunday's 7 included), and one longer than its field keeps only its start.
  const from = new Date("2026-11-15T12:00:00Z");
  const cases: [string, string[]][] = [
    ["5/15 * * * *", ["2026-11-15T12:05Z", "2026-11-15T12:20Z", "2026-11-15T12:35Z", "2026-11-15T12:50Z"]],
    ["0 5/6 * * *", ["2026-11-15T17:00Z", "2026-11-15T23:00Z", "2026-11-16T05:00Z", "2026-11-16T11:00Z"]],
    ["0 9 25/3 * *", ["2026-11-25T09:00Z", "2026-11-28T09:00Z", "2026-12-25T09:00Z", "2026-12-28T09:00Z"]],
    ["0 9 1 10/1 *", ["2026-12-01T09:00Z", "2027-10-01T09:00Z", "2027-11-01T09:00Z", "2027-12-01T09:00Z"]],
    ["0 9 * * 1/2", ["2026-11-16T09:00Z", "2026-11-18T09:00Z", "2026-11-20T09:00Z", "2026-11-22T09:00Z"]],
    ["0 9 * * fri/2", ["2026-11-20T09:00Z", "2026-11-22T09:00Z", "2026-11-27T09:00Z", "2026-11-29T09:00Z"]],
    ["0 9 * * 7/2", ["2026-11-22T09:00Z", "2026-11-29T09:00Z", "2026-12-06T09:00Z", "2026-12-13T09:00Z"]],
    ["*/100 * * * *", ["2026-11-15T13:00Z", "2026-11-15T14:00Z", "2026-11-15T15:00Z", "2026-11-15T16:00Z"]],
    ["0 */100 * * *", ["2026-11-16T00:00Z", "2026-11-17T00:00Z", "2026-11-18T00:00Z", "2026-11-19T00:00Z"]],
    ["0 9 1-10/40 * *", ["2026-12-01T09:00Z", "2027-01-01T09:00Z", "2027-02-01T09:00Z", "2027-03-01T09:00Z"]],
    ["0 9 * * 1-5/10", ["2026-11-16T09:00Z", "2026-11-23T09:00Z", "2026-11-30T09:00Z", "2026-12-07T09:00Z"]],
    ["0 9 L * *", ["2026-11-30T09:00Z", "2026-12-31T09:00Z", "2027-01-31T09:00Z", "2027-02-28T09:00Z"]],
    ["0 9 * * 5L", ["2026-11-27T09:00Z", "2026-12-25T09:00Z", "2027-01-29T09:00Z", "2027-02-26T09:00Z"]],
    ["0 9 * * FRI#2", ["2026-12-11T09:00Z", "2027-01-08T09:00Z", "2027-02-12T09:00Z", "2027-03-12T09:00Z"]],
    ["0 9 * * *#2", ["2026-12-08T09:00Z", "2026-12-09T09:00Z", "2026-12-10T09:00Z", "2026-12-11T09:00Z"]],
    ["0 9 ? * MON", ["2026-11-16T09:00Z", "2026-11-23T09:00Z", "2026-11-30T09:00Z", "2026-12-07T09:00Z"]],
    ["0 9 1 jan,JUL *", ["2027-01-01T09:00Z", "2027-07-01T09:00Z", "2028-01-01T09:00Z", "2028-07-01T09:00Z"]],
    ["0 9 * * 0-7", ["2026-11-16T09:00Z", "2026-11-17T09:00Z", "2026-11-18T09:00Z", "2026-11-19T09:00Z"]],
    // SUN is 0, at either end of a range.
    ["0 9 * * SUN-SUN", ["2026-11-22T09:00Z", "2026-11-29T09:00Z", "2026-12-06T09:00Z", "2026-12-13T09:00Z"]],
    ["0 9 * * SUN-SUN/2", ["2026-11-22T09:00Z", "2026-11-29T09:00Z", "2026-12-06T09:00Z", "2026-12-13T09:00Z"]],
    ["0 9 * * SUN-1", ["2026-11-16T09:00Z", "2026-11-22T09:00Z", "2026-11-23T09:00Z", "2026-11-29T09:00Z"]],
    ["0 9 1 JAN-DEC/5 *", ["2027-01-01T09:00Z", "2027-06-01T09:00Z", "2027-11-01T09:00Z", "2028-01-01T09:00Z"]],
    // Day of month or day of week, when both are given.
    ["0 9 13 * 5", ["2026-11-20T09:00Z", "2026-11-27T09:00Z", "2026-12-04T09:00Z", "2026-12-11T09:00Z"]],
    ["00 09 * * SUN", ["2026-11-22T09:00Z", "2026-11-29T09:00Z", "2026-12-06T09:00Z", "2026-12-13T09:00Z"]],
  ];
  for (const [cron, fires] of cases) {
    expect(cronProblem(cron, "UTC"), cron).toBeNull();
    expect(nextFires(cron, "UTC", from, 4), cron).toEqual(fires.map((f) => new Date(f)));
  }
});

test("reads fires decades apart, and refuses a cron that never fires", () => {
  // A fifth Monday in February: 29 February on a Monday, 40 years apart across 2100.
  expect(nextFireAfter("0 9 * 2 1#5", "UTC", new Date("2026-11-15T00:00:00Z"))).toEqual(new Date("2044-02-29T09:00:00Z"));
  expect(nextFireAfter("0 9 * 2 1#5", "UTC", new Date("2072-03-01T00:00:00Z"))).toEqual(new Date("2112-02-29T09:00:00Z"));
  expect(nextFires("0 9 * 2 1#5", "UTC", new Date("2026-11-15T00:00:00Z"), 3)).toEqual(
    ["2044-02-29T09:00:00Z", "2072-02-29T09:00:00Z", "2112-02-29T09:00:00Z"].map((d) => new Date(d)),
  );
  // Every minute of 02:00 on the last Sunday of March: Paris skips that hour each year.
  expect(cronProblem("* 2 * 3 0L", PARIS)).toMatchObject({ key: "workflows.schedule.unreadable" });
  expect(cronProblem("* 2 * 3 0L", "UTC")).toBeNull();
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
