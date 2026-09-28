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
  if (filter.since === undefined) return false;
  const at = Date.parse(entry.timestamp);
  return Number.isFinite(at) && at < Date.parse(filter.since);
}
