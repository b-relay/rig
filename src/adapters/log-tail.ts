import { stat } from "node:fs/promises";
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
  /** The offset is inside an over-long run already reported as one unreadable record: a follow skips the rest of it. */
  midRecord?: true;
}
/** Writers of different components append in the order their lines are recorded, which may run a little behind their
 * times: a recent read walks this far past `since` before it stops, so no line inside the window is missed. */
const SINCE_SLACK_MS = 60_000;

/** The newest entries of one family that `filter` keeps, at most `limit`, oldest first; and where each file it opened
 * ends, for a follow to resume from. The family's files are walked back from the newest line, generation by generation,
 * and the walk stops once `limit` entries are kept or it passes `since`, so older generations are never opened. The
 * current file is always opened for its position. A family `filter` cannot match (see `familyMayMatch`) is not opened
 * at all: it has no entries and no position. Fails LOG_UNREADABLE for a file that cannot be read. */
export async function readFamilyTail(
  root: string,
  family: { readonly family: string; readonly members: readonly LogSource[] },
  limit: number,
  filter: LogFilter,
): Promise<{
  entries: TargetLogEntry[];
  positions: Record<string, LogPosition>;
}> {
  if (!familyMayMatch(family.family, filter))
    return { entries: [], positions: {} };
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
  let unreadable: { size: number; atLeast: boolean }[] = [];
  const settle = (timestamp: string | undefined) => {
    for (const { size, atLeast } of unreadable)
      keep(unreadableEntry(size, timestamp, atLeast));
    unreadable = [];
  };
  // Lines launchd wrote have no time, so an unreadable one among them has none to take either: it is kept at once.
  const timeless = familyEvidence(family.family) !== undefined;
  // An unreadable record names no component or stream, so a --service or --stream read never keeps one.
  const unreadableKept = !filter.services && !filter.stream;
  // Without a time bound every unreadable record is kept, so a full page of them ends the walk once the time they take
  // is found, or once a window's worth of bytes past it has none.
  const unreadableCounts =
    unreadableKept && filter.since === undefined && filter.until === undefined;
  let bytesPastFullPage = 0;
  /** Bytes of records before the since bound read in a row. A record can be appended after newer ones when its writer was
   * held up between timing it and writing it (as across a sleep), so its time says nothing of the records before it: one
   * such record does not end the walk, a window's worth of them in a row does. Whether an older generation can hold a line
   * inside the window is decided by when it was last written instead (see `writtenBefore`). */
  let bytesPastSince = 0;
  let done = false;
  for (const member of [...family.members].reverse()) {
    if (done && member.generation > 0) break;
    // A rotated generation last written before the bound holds only lines timed before it, as does every older one: none
    // is opened, so an unreadable one never fails the read.
    if (
      member.generation > 0 &&
      stopBefore.since !== undefined &&
      (await writtenBefore(join(root, member.name), stopBefore.since))
    )
      break;
    const log = await openLog(join(root, member.name));
    if (!log) continue;
    try {
      const { end, midRecord } = await completeEnd(log.handle, log.size);
      positions[member.name] = {
        identity: log.identity,
        offset: end,
        ...(midRecord ? { midRecord } : {}),
      };
      if (done) continue;
      for await (const line of linesBackward(log.handle, end, midRecord)) {
        const parsed =
          line.text === undefined
            ? "unreadable"
            : parseLogRecord(family.family, line.text);
        if (parsed === undefined) continue;
        if (parsed === "unreadable") {
          if (!unreadableKept) continue;
          if (unreadable.length < limit - kept.length) {
            unreadable.push({
              size: line.size,
              atLeast: line.atLeast === true,
            });
            if (timeless) settle(undefined);
            if (kept.length >= limit) {
              done = true;
              break;
            }
          } else if (
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
          if ((bytesPastSince += line.size + 1) > LOG_WINDOW_BYTES) {
            done = true;
            break;
          }
          continue;
        }
        bytesPastSince = 0;
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

/** Whether the file at `path` was last written before `time`: every line in it was timed before it too, since a line is
 * timed before it is written. A file that is gone, or cannot be looked at, is not known to be. */
async function writtenBefore(path: string, time: string): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs < Date.parse(time);
  } catch {
    return false;
  }
}
/** Whether any line of `family` can pass `filter`. A family of records (`target.jsonl`, `events.jsonl`) always may; a
 * family of plain lines launchd wrote belongs to one component and stream, and has no times, so a filter on another
 * component or stream, or any time bound, excludes all of it. */
export function familyMayMatch(family: string, filter: LogFilter): boolean {
  const evidence = familyEvidence(family);
  return (
    !evidence || matchesLogFilter({ timestamp: "unknown", ...evidence }, filter)
  );
}
