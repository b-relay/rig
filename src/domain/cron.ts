/** Standard five-field cron schedules evaluated in an IANA time zone. Pure: no clock, no I/O; the caller passes the instant
 * to count from and the zone to read wall-clock time in.
 *
 * Daylight saving time, the one rule both sides of a transition follow (see docs/adr/0013-scheduled-jobs.md):
 * - A wall time the spring change skips (02:30 when clocks jump from 02:00 to 03:00) runs at the change itself, the first
 *   instant after the gap, once however many skipped times the schedule names.
 * - A wall time the autumn change repeats (01:30 when clocks fall back from 02:00 to 01:00) runs once, at its first
 *   occurrence.
 * So a daily job runs exactly once on both days, and the wall-clock-to-instant mapping never runs backwards. */

/** One parsed schedule: the minutes, hours, days of the month, months and weekdays it names. */
export interface CronSchedule {
  /** The expression as written. */
  readonly expression: string;
  /** Ascending minutes, 0-59. */
  readonly minutes: readonly number[];
  /** Ascending hours, 0-23. */
  readonly hours: readonly number[];
  /** Days of the month, 1-31. */
  readonly days: ReadonlySet<number>;
  /** Months, 1-12. */
  readonly months: ReadonlySet<number>;
  /** Weekdays, 0 (Sunday) to 6; 7 is read as Sunday. */
  readonly weekdays: ReadonlySet<number>;
  /** The day-of-month field names particular days (does not start with `*`). */
  readonly dayRestricted: boolean;
  /** The weekday field names particular days (does not start with `*`). */
  readonly weekdayRestricted: boolean;
}

interface FieldRule {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}
const FIELDS: readonly FieldRule[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of the month", min: 1, max: 31 },
  {
    label: "month",
    min: 1,
    max: 12,
    names: [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ],
  },
  {
    label: "day of the week",
    min: 0,
    max: 7,
    names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
  },
];
/** The most days in each month, February counted in a leap year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** How far ahead a next run is looked for before a schedule is taken to have none. */
const SEARCH_DAYS = 366 * 5;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Parses a standard five-field cron expression (minute, hour, day of the month, month, day of the week), with `*`,
 * numbers, `a-b` ranges, `,` lists, `/n` steps, and English month and weekday names such as jan or mon. When both day
 * fields name particular days, a day matching either runs, as in cron. Returns why the expression is refused instead. */
export function parseCron(
  expression: string,
): CronSchedule | { problem: string } {
  const fields = expression.trim().split(/\s+/);
  if (expression.trim().startsWith("@"))
    return {
      problem:
        "must be five cron fields; @ shortcuts are not supported, so write @daily as 0 0 * * * and @hourly as 0 * * * *",
    };
  if (fields.length !== 5)
    return {
      problem: `must be five cron fields (minute hour day-of-month month day-of-week), such as 17 */6 * * *; it has ${fields.length}`,
    };
  const values: number[][] = [];
  for (const [index, field] of fields.entries()) {
    const parsed = parseField(field, FIELDS[index]!);
    if ("problem" in parsed) return parsed;
    values.push(parsed.values);
  }
  const [minutes, hours, days, months, weekdays] = values as [
    number[],
    number[],
    number[],
    number[],
    number[],
  ];
  const schedule: CronSchedule = {
    expression,
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((day) => day % 7)),
    dayRestricted: !fields[2]!.startsWith("*"),
    weekdayRestricted: !fields[4]!.startsWith("*"),
  };
  // A day of the month no listed month has (such as 30 2 for February 30th) would never run.
  if (
    schedule.dayRestricted &&
    !schedule.weekdayRestricted &&
    !months.some((month) => days.some((day) => day <= MONTH_DAYS[month - 1]!))
  )
    return {
      problem:
        "names no day that exists: none of its days of the month falls in any of its months",
    };
  return schedule;
}
function parseField(
  field: string,
  rule: FieldRule,
): { values: number[] } | { problem: string } {
  const values = new Set<number>();
  const refuse = (detail: string) => ({
    problem: `has an invalid ${rule.label} field '${field}': ${detail}`,
  });
  for (const item of field.split(",")) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(item);
    if (!match)
      return refuse(
        `use *, a number, a range such as 1-5, a list such as 1,15, or a step such as */6`,
      );
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1)
      return refuse("a step must be a whole number of at least 1");
    let low: number, high: number;
    if (match[1] === "*") {
      low = rule.min;
      high = rule.max;
    } else {
      const [first, second] = match[1]!.split("-");
      const from = fieldValue(first!, rule),
        to = second === undefined ? undefined : fieldValue(second, rule);
      if (from === undefined || (second !== undefined && to === undefined))
        return refuse(
          `values run from ${rule.min} to ${rule.max}${rule.names ? ` or are names such as ${rule.names[0]}` : ""}`,
        );
      low = from;
      // `5/15` means from 5 to the end in steps of 15, as in cron.
      high = to ?? (match[2] === undefined ? from : rule.max);
      if (high < low)
        return refuse("a range must run from its smaller to its larger value");
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b) };
}
function fieldValue(text: string, rule: FieldRule): number | undefined {
  const named = rule.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return rule.min === 1 ? named + 1 : named;
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= rule.min && value <= rule.max ? value : undefined;
}

/** Whether `name` is an IANA time zone this Host knows, such as America/Chicago or UTC. Fixed offsets such as +05:00 are
 * not names and are refused. */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) return false;
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

/** The first instant strictly after `after` (Unix milliseconds) at which `schedule` runs in `timeZone`; undefined when it
 * names no time in the next five years. Runs fall on whole minutes of wall-clock time in that zone, with the daylight
 * saving rule at the top of this file. */
export function nextRun(
  schedule: CronSchedule,
  after: number,
  timeZone: string,
): number | undefined {
  const start = wallClock(after, timeZone);
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const date = new Date(
      Date.UTC(start.year, start.month - 1, start.day + offset),
    );
    const year = date.getUTCFullYear(),
      month = date.getUTCMonth() + 1,
      day = date.getUTCDate();
    if (!runsOn(schedule, month, day, date.getUTCDay())) continue;
    const first = offset === 0;
    for (const hour of schedule.hours) {
      if (first && hour < start.hour) continue;
      for (const minute of schedule.minutes) {
        if (first && hour === start.hour && minute < start.minute) continue;
        const instant = instantOf(
          Date.UTC(year, month - 1, day, hour, minute),
          timeZone,
        );
        if (instant > after) return instant;
      }
    }
  }
  return undefined;
}
function runsOn(
  schedule: CronSchedule,
  month: number,
  day: number,
  weekday: number,
): boolean {
  if (!schedule.months.has(month)) return false;
  const byDay = schedule.days.has(day),
    byWeekday = schedule.weekdays.has(weekday);
  // cron's rule: with both day fields restricted, either one matching is enough.
  if (schedule.dayRestricted && schedule.weekdayRestricted)
    return byDay || byWeekday;
  return byDay && byWeekday;
}

/** The wall-clock fields of `instant` in `timeZone`. */
export function wallClock(
  instant: number,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}
/** Minutes `timeZone` is ahead of UTC at `instant`. */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return Math.round(
    (asUtc - (instant - (((instant % 1000) + 1000) % 1000))) / MINUTE_MS,
  );
}
/** The instant a wall-clock minute (written as if it were UTC) happens in `timeZone`: the earlier one when the autumn change
 * repeats it, the change itself when the spring change skips it. */
function instantOf(wall: number, timeZone: string): number {
  const offsets = [
    ...new Set([
      offsetAt(wall - DAY_MS, timeZone),
      offsetAt(wall, timeZone),
      offsetAt(wall + DAY_MS, timeZone),
    ]),
  ];
  // An offset is the zone's at the wall time when the instant it gives has that same offset.
  const valid = offsets
    .filter(
      (offset) => offsetAt(wall - offset * MINUTE_MS, timeZone) === offset,
    )
    .map((offset) => wall - offset * MINUTE_MS);
  if (valid.length) return Math.min(...valid);
  // Skipped by the spring change: the change happens between reading the wall time under the later offset (still before
  // the change) and under the earlier one (already after it). Find that minute.
  let low = wall - Math.max(...offsets) * MINUTE_MS,
    high = wall - Math.min(...offsets) * MINUTE_MS;
  const before = offsetAt(low, timeZone);
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / (2 * MINUTE_MS)) * MINUTE_MS;
    if (offsetAt(middle, timeZone) === before) low = middle;
    else high = middle;
  }
  return high;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
/** One formatter per zone; constructing it is what validates the zone name. */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, found);
  }
  return found;
}
/** The Host's own time zone, the default for a job without `timezone`: the Mac's setting, or TZ when it is set. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
