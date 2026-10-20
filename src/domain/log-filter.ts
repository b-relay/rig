import type { TargetLogEntry } from "../providers/contracts";

/** Which Target log entries a `rig logs` read returns. Every field narrows the read; an empty filter keeps every entry. */
export interface LogFilter {
  /** Component names (a Service, a Tool, or `setup`); entries of any other component are left out. */
  readonly services?: readonly string[];
  /** Keeps only entries of this stream; health and unknown-stream evidence are left out. */
  readonly stream?: "stdout" | "stderr";
  /** ISO instant; entries recorded before it are left out, and so is every entry whose time is unknown. */
  readonly since?: string;
  /** ISO instant; entries recorded after it are left out, and so is every entry whose time is unknown. */
  readonly until?: string;
}

/** Whether `entry` belongs in a read narrowed by `filter`. Both time bounds are inclusive. */
export function matchesLogFilter(
  entry: Pick<TargetLogEntry, "timestamp" | "component" | "stream">,
  filter: LogFilter,
): boolean {
  if (filter.services && !filter.services.includes(entry.component))
    return false;
  if (filter.stream && entry.stream !== filter.stream) return false;
  if (filter.since === undefined && filter.until === undefined) return true;
  const at = Date.parse(entry.timestamp);
  if (!Number.isFinite(at)) return false;
  if (filter.since !== undefined && at < Date.parse(filter.since)) return false;
  if (filter.until !== undefined && at > Date.parse(filter.until)) return false;
  return true;
}

/** Whether `entry` was recorded, by its known time, before the filter's `since` bound. An entry of unknown time never is. */
export function precedesLogWindow(
  entry: Pick<TargetLogEntry, "timestamp">,
  filter: Pick<LogFilter, "since">,
): boolean {
  return precedesSince(filter.since)(entry.timestamp);
}
/** `precedesLogWindow` for one `since` bound, which is checked once: for a read that walks many records. */
export function precedesSince(
  since: string | undefined,
): (timestamp: string) => boolean {
  if (since === undefined) return () => false;
  // Rig writes every time in this one form, which a read walking a large log compares as text, without parsing it.
  const written = isWrittenTime(since);
  const bound = Date.parse(since);
  return (timestamp) => {
    if (written && isWrittenTime(timestamp)) return timestamp < since;
    const at = Date.parse(timestamp);
    return Number.isFinite(at) && at < bound;
  };
}
/** Whether `text` is a real instant in the form `Date.toISOString` writes (UTC, to the millisecond), whose order as text
 * is its order in time. A date or time out of range (month 00, February 30th, 24:00) is not: it is unknown or rolls
 * over when parsed, so only parsing places it. Read a character at a time, as it runs for every record a read walks. */
function isWrittenTime(text: string): boolean {
  if (
    text.length !== 24 ||
    text[4] !== "-" ||
    text[7] !== "-" ||
    text[10] !== "T" ||
    text[13] !== ":" ||
    text[16] !== ":" ||
    text[19] !== "." ||
    text[23] !== "Z"
  )
    return false;
  const year = digits(text, 0, 4),
    month = digits(text, 5, 7),
    day = digits(text, 8, 10);
  return (
    year >= 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    inRange(digits(text, 11, 13), 23) &&
    inRange(digits(text, 14, 16), 59) &&
    inRange(digits(text, 17, 19), 59) &&
    digits(text, 20, 23) >= 0
  );
}
/** The number the decimal digits of `text` from `from` to `to` spell; -1 when one is not a digit. */
function digits(text: string, from: number, to: number): number {
  let value = 0;
  for (let at = from; at < to; at++) {
    const digit = text.charCodeAt(at) - 48;
    if (digit < 0 || digit > 9) return -1;
    value = value * 10 + digit;
  }
  return value;
}
function inRange(value: number, max: number): boolean {
  return value >= 0 && value <= max;
}
function daysIn(year: number, month: number): number {
  if (month === 2)
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
