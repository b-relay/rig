import { join } from "node:path";
import {
  matchesLogFilter,
  precedesLogWindow,
  type LogFilter,
} from "../domain/log-filter";
import type { TargetLogEntry } from "../providers/contracts";
import {
  completeEnd,
  linesBackward,
  LOG_WINDOW_BYTES,
  openLog,
} from "./log-files";
import { parseLogRecord, unreadableEntry } from "./log-records";
import { familyEvidence, type LogSource } from "./log-sources";

/** Where a follow resumes in one file: its identity and the byte offset just past the last line already read. */
export interface LogPosition {
  identity: string;
  offset: number;
}
/** Writers of different components append in the order their lines are recorded, which may run a little behind their
 * times: a recent read walks this far past `since` before it stops, so no line inside the window is missed. */
const SINCE_SLACK_MS = 60_000;

/** The newest entries of one family that `filter` keeps, at most `limit`, oldest first; and where each file it opened
 * ends, for a follow to resume from. The family's files are walked back from the newest line, generation by generation,
 * and the walk stops once `limit` entries are kept or it passes `since`, so older generations are never opened. The
 * current file is always opened for its position; a family `filter` cannot match (a wrapper log of another Service, or
 * any launchd file under a time bound, since its lines have no time) is not read. Fails LOG_UNREADABLE for a file that
 * cannot be read. */
export async function readFamilyTail(
  root: string,
  family: { readonly family: string; readonly members: readonly LogSource[] },
  limit: number,
  filter: LogFilter,
): Promise<{
  entries: TargetLogEntry[];
  positions: Record<string, LogPosition>;
}> {
  const evidence = familyEvidence(family.family);
  const searching =
    !evidence ||
    matchesLogFilter({ timestamp: "unknown", ...evidence }, filter);
  const stopBefore =
    filter.since === undefined
      ? {}
      : {
          since: new Date(
            Date.parse(filter.since) - SINCE_SLACK_MS,
          ).toISOString(),
        };
  const positions: Record<string, LogPosition> = {};
  /** Newest first. */
  const kept: TargetLogEntry[] = [];
  const keep = (entry: TargetLogEntry) => {
    if (matchesLogFilter(entry, filter)) kept.push(entry);
  };
  /** Sizes of unreadable records met since the last readable one; they take the time of the readable record before them.
   * Only as many are held as could still make the page: older ones are counted, never kept. */
  let unreadable: number[] = [];
  const settle = (timestamp: string | undefined) => {
    for (const size of unreadable) keep(unreadableEntry(size, timestamp));
    unreadable = [];
  };
  // An unreadable record names no component or stream, so a --service or --stream read never keeps one.
  const unreadableKept = !filter.services && !filter.stream;
  // Without a time bound every unreadable record is kept, so a full page of them ends the walk once the time they take
  // is found, or once a window's worth of bytes past it has none.
  const unreadableCounts =
    unreadableKept && filter.since === undefined && filter.until === undefined;
  let bytesPastFullPage = 0;
  let done = !searching;
  for (const member of [...family.members].reverse()) {
    if (done && member.generation > 0) break;
    const log = await openLog(join(root, member.name));
    if (!log) continue;
    try {
      const end = await completeEnd(log.handle, log.size);
      positions[member.name] = { identity: log.identity, offset: end };
      if (done) continue;
      for await (const line of linesBackward(log.handle, end)) {
        const parsed =
          line.text === undefined
            ? "unreadable"
            : parseLogRecord(family.family, line.text);
        if (parsed === undefined) continue;
        if (parsed === "unreadable") {
          if (!unreadableKept) continue;
          if (unreadable.length < limit - kept.length)
            unreadable.push(line.size);
          else if (
            unreadableCounts &&
            (bytesPastFullPage += line.size + 1) > LOG_WINDOW_BYTES
          ) {
            done = true;
            break;
          }
          continue;
        }
        settle(parsed.timestamp);
        if (precedesLogWindow(parsed, stopBefore)) {
          done = true;
          break;
        }
        keep(parsed);
        if (kept.length >= limit) {
          done = true;
          break;
        }
      }
    } finally {
      await log.handle.close();
    }
  }
  settle(undefined);
  return { entries: kept.slice(0, limit).reverse(), positions };
}
