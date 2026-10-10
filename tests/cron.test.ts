import { expect, test } from "bun:test";
import {
  isTimeZone,
  nextRun,
  parseCron,
  wallClock,
  type CronSchedule,
} from "../src/domain/cron";

const CHICAGO = "America/Chicago";
function schedule(expression: string): CronSchedule {
  const parsed = parseCron(expression);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return parsed;
}
/** The next `count` runs after `from`, as ISO instants. */
function runs(
  expression: string,
  from: string,
  count: number,
  zone = CHICAGO,
): string[] {
  const found: string[] = [];
  let at = Date.parse(from);
  for (let i = 0; i < count; i++) {
    at = nextRun(schedule(expression), at, zone)!;
    found.push(new Date(at).toISOString());
  }
  return found;
}

test("Melody's schedules run at their wall-clock times in the job's zone", () => {
  // 2026-10-10 is a Saturday; Chicago is UTC-5 in October.
  expect(runs("17 */6 * * *", "2026-10-10T12:00:00Z", 4)).toEqual([
    "2026-10-10T17:17:00.000Z",
    "2026-10-10T23:17:00.000Z",
    "2026-10-11T05:17:00.000Z",
    "2026-10-11T11:17:00.000Z",
  ]);
  expect(runs("43 4 * * *", "2026-10-10T12:00:00Z", 2)).toEqual([
    "2026-10-11T09:43:00.000Z",
    "2026-10-12T09:43:00.000Z",
  ]);
  // Wednesdays and Saturdays at 07:00.
  expect(runs("0 7 * * 3,6", "2026-10-10T12:00:00Z", 3)).toEqual([
    "2026-10-14T12:00:00.000Z",
    "2026-10-17T12:00:00.000Z",
    "2026-10-21T12:00:00.000Z",
  ]);
  // The same expression in UTC never shifts.
  expect(runs("0 11 * * 3,6", "2026-10-10T12:00:00Z", 1, "UTC")).toEqual([
    "2026-10-14T11:00:00.000Z",
  ]);
});

test("a run is strictly after the instant it counts from, so a run never repeats", () => {
  expect(runs("0 7 * * *", "2026-10-10T12:00:00.000Z", 1)).toEqual([
    "2026-10-11T12:00:00.000Z",
  ]);
  expect(runs("* * * * *", "2026-10-10T12:00:30.000Z", 2)).toEqual([
    "2026-10-10T12:01:00.000Z",
    "2026-10-10T12:02:00.000Z",
  ]);
});

test("a time the spring change skips runs once at the change, and the next day as written", () => {
  // Chicago jumps from 02:00 CST to 03:00 CDT on 2026-03-08 (08:00 UTC).
  expect(runs("30 2 * * *", "2026-03-07T12:00:00Z", 3)).toEqual([
    "2026-03-08T08:00:00.000Z",
    "2026-03-09T07:30:00.000Z",
    "2026-03-10T07:30:00.000Z",
  ]);
  // Every skipped time maps to the change, which runs once; the hour after it runs as written.
  expect(runs("*/20 2,3 * * *", "2026-03-08T07:00:00Z", 3)).toEqual([
    "2026-03-08T08:00:00.000Z",
    "2026-03-08T08:20:00.000Z",
    "2026-03-08T08:40:00.000Z",
  ]);
});

test("a time the autumn change repeats runs once, the first time", () => {
  // Chicago falls back from 02:00 CDT to 01:00 CST on 2026-11-01 (07:00 UTC); 01:30 happens twice.
  expect(runs("30 1 * * *", "2026-10-31T12:00:00Z", 2)).toEqual([
    "2026-11-01T06:30:00.000Z",
    "2026-11-02T07:30:00.000Z",
  ]);
  // Counting from inside the repeated hour finds no second 01:xx run.
  expect(runs("*/20 1 * * *", "2026-11-01T06:50:00Z", 1)).toEqual([
    "2026-11-02T07:00:00.000Z",
  ]);
  expect(wallClock(Date.parse("2026-11-01T07:30:00Z"), CHICAGO)).toMatchObject({
    hour: 1,
    minute: 30,
  });
});

test("with both day fields restricted, either one matching runs it, as in cron", () => {
  // The 1st of the month, or any Monday: 2026-10-12 is a Monday, 2026-11-01 the 1st.
  expect(runs("0 0 1 * mon", "2026-10-10T12:00:00Z", 4, "UTC")).toEqual([
    "2026-10-12T00:00:00.000Z",
    "2026-10-19T00:00:00.000Z",
    "2026-10-26T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
  ]);
  // A starred weekday leaves the day of the month alone, and 7 is Sunday.
  expect(runs("0 0 * * 7", "2026-10-10T12:00:00Z", 1, "UTC")).toEqual([
    "2026-10-11T00:00:00.000Z",
  ]);
  expect(runs("0 0 29 feb *", "2026-03-01T00:00:00Z", 1, "UTC")).toEqual([
    "2028-02-29T00:00:00.000Z",
  ]);
});

test("ranges, lists, steps and names parse as cron reads them", () => {
  const parsed = schedule("5/20 9-17/4 1,15 jan-mar,dec mon-fri");
  expect(parsed.minutes).toEqual([5, 25, 45]);
  expect(parsed.hours).toEqual([9, 13, 17]);
  expect([...parsed.days].sort((a, b) => a - b)).toEqual([1, 15]);
  expect([...parsed.months].sort((a, b) => a - b)).toEqual([1, 2, 3, 12]);
  expect([...parsed.weekdays].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});

test("an expression cron would not read, or one that never runs, is refused with why", () => {
  const problem = (expression: string) =>
    (parseCron(expression) as { problem?: string }).problem;
  expect(problem("0 7 * *")).toContain("five cron fields");
  expect(problem("@daily")).toContain("write @daily as 0 0 * * *");
  expect(problem("60 * * * *")).toContain("minute field '60'");
  expect(problem("0 24 * * *")).toContain("hour field");
  expect(problem("0 0 0 * *")).toContain("day of the month");
  expect(problem("0 0 * 13 *")).toContain("month field");
  expect(problem("0 0 * * 8")).toContain("day of the week");
  expect(problem("*/0 * * * *")).toContain("step");
  expect(problem("0 5-1 * * *")).toContain("smaller to its larger");
  expect(problem("0 0 30 2 *")).toContain("names no day that exists");
});

test("only IANA zone names this Host knows are time zones", () => {
  for (const zone of ["America/Chicago", "Europe/Berlin", "UTC"])
    expect(isTimeZone(zone)).toBe(true);
  for (const zone of ["Mars/Olympus", "+05:00", "", "America/Chicago "])
    expect(isTimeZone(zone)).toBe(false);
});
