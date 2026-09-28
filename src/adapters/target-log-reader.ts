import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TargetRecord } from "../domain/runtime";
import type { TargetLogEntry } from "../providers/contracts";
import { RigError } from "../domain/errors";
import { matchesLogFilter, type LogFilter } from "../domain/log-filter";
import {
  LOG_WINDOW_BYTES,
  nextNewline,
  openLog,
  readAt,
  type OpenLog,
} from "./log-files";
import { parseLogRecord, unreadableEntry } from "./log-records";
import {
  familyRotates,
  logFamilies,
  logSource,
  type LogSource,
} from "./log-sources";
import { familyMayMatch, readFamilyTail, type LogPosition } from "./log-tail";

const positionSchema = z
  .object({ identity: z.string(), offset: z.number().int().nonnegative() })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    target: z.string(),
    sources: z.record(z.string(), positionSchema),
  })
  .strict();
interface LogRow {
  end: number;
  entry?: TargetLogEntry;
}
interface SourceWindow {
  source: LogSource;
  position: LogPosition;
  rows: LogRow[];
}
const cursorError = () =>
  new RigError(
    "LOG_CURSOR",
    "The Target log cursor is invalid or its files changed.",
    "Read logs again without a cursor.",
  );

/** Read-only current/legacy log view. Without `after`, the newest `lines` entries `filter` keeps, across every retained
 * generation (see `readFamilyTail`); with `after`, the next entries past that cursor, at most `lines`, reading at most
 * 4 MiB per file per call, with entries `filter` leaves out passed over. Incomplete final lines wait for a later read.
 * Cursors belong to this Target and follow each file by identity, so a follow carries on across rotation; a file that
 * rotated out of retention is dropped, while one truncated in place or a Target log directory that is gone fails
 * LOG_CURSOR. A complete record that cannot be parsed, or a run longer than the window, becomes one "unreadable record"
 * entry so reading and following continue past it. Unknown legacy timestamps/streams remain explicit, and diagnostic
 * event details are never rendered. */
export async function readTargetLogs(
  target: TargetRecord,
  after: string | undefined,
  lines: number,
  filter: LogFilter = {},
): Promise<{ entries: TargetLogEntry[]; cursor: string }> {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000)
    throw new RigError(
      "LOG_LIMIT",
      "Request between 1 and 10000 log entries.",
      "Correct the requested line limit.",
    );
  const identity = createHash("sha256")
    .update(JSON.stringify([target.id, target.logRoot]))
    .digest("hex");
  const sources = await listSources(target.logRoot);
  const read =
    after === undefined
      ? await readRecent(target.logRoot, sources ?? [], lines, filter)
      : await readFollowing(
          target.logRoot,
          sources,
          decodeCursor(after, identity),
          lines,
          filter,
        );
  return {
    entries: read.entries,
    cursor: Buffer.from(
      JSON.stringify({ version: 1, target: identity, sources: read.positions }),
    ).toString("base64url"),
  };
}
interface Read {
  entries: TargetLogEntry[];
  positions: Record<string, LogPosition>;
}
/** The Target log files in `root`; undefined when the directory does not exist. */
async function listSources(root: string): Promise<LogSource[] | undefined> {
  try {
    return (await readdir(root)).flatMap((name) => logSource(name) ?? []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Each family contributes its newest kept entries; entries of unknown time precede dated history without inventing a
 * chronological position. */
async function readRecent(
  root: string,
  sources: readonly LogSource[],
  lines: number,
  filter: LogFilter,
): Promise<Read> {
  const all: { entry: TargetLogEntry; family: string; index: number }[] = [];
  const positions: Record<string, LogPosition> = {};
  for (const family of logFamilies(sources)) {
    const tail = await readFamilyTail(root, family, lines, filter);
    tail.entries.forEach((entry, index) =>
      all.push({ entry, family: family.family, index }),
    );
    Object.assign(positions, tail.positions);
  }
  all.sort(
    (a, b) =>
      compareEntries(a.entry, b.entry) ||
      a.family.localeCompare(b.family) ||
      a.index - b.index,
  );
  return { entries: all.slice(-lines).map((row) => row.entry), positions };
}
async function readFollowing(
  root: string,
  listed: readonly LogSource[] | undefined,
  following: Record<string, LogPosition>,
  lines: number,
  filter: LogFilter,
): Promise<Read> {
  // A family the filter excludes is neither opened nor followed, as the first read left it out.
  const included = (name: string) =>
    familyMayMatch(logSource(name)!.family, filter);
  const previous = Object.fromEntries(
    Object.entries(following).filter(([name]) => included(name)),
  );
  const snapshot = await openSnapshot(root, listed, included);
  const { sources, opened } = snapshot;
  try {
    const positions = rebind(opened, previous, sources !== undefined);
    const names = new Set([...opened.keys(), ...Object.keys(positions)]);
    const windows: SourceWindow[] = [];
    for (const name of [...names].sort()) {
      const source = logSource(name)!;
      const log = opened.get(name);
      // A source the cursor knew has gone: that is a cursor problem, not a missing log.
      if (!log) throw cursorError();
      // An older generation the cursor never covered is history the first read already chose from.
      if (!positions[name] && source.generation > 0) continue;
      windows.push(await readWindow(log, source, positions[name]));
    }
    return {
      entries: nextEntries(windows, lines, filter),
      positions: Object.fromEntries(
        windows.map((window) => [window.source.name, window.position]),
      ),
    };
  } finally {
    for (const log of opened.values()) await log.handle.close();
  }
}
/** Opens every included Target log once, the current file of a family before its older generations, and checks that no
 * rotation happened while they were opened: each name must still be the file opened under it, and no two names the same
 * file. Otherwise a rotation between two opens could show one file under two names, and the follow would read it twice
 * or lose its place. After three unsettled tries the last snapshot is used; rotations are seconds apart at the least. */
async function openSnapshot(
  root: string,
  listed: readonly LogSource[] | undefined,
  included: (name: string) => boolean,
): Promise<{
  sources: readonly LogSource[] | undefined;
  opened: Map<string, OpenLog>;
}> {
  let sources = listed;
  for (let attempt = 1; ; attempt++) {
    const opened = new Map<string, OpenLog>();
    try {
      for (const source of [...(sources ?? [])]
        .filter((each) => included(each.name))
        .sort((a, b) => a.generation - b.generation)) {
        const log = await openLog(join(root, source.name));
        if (log) opened.set(source.name, log);
      }
      if (attempt === 3 || (await settled(root, opened)))
        return { sources, opened };
    } catch (error) {
      for (const log of opened.values()) await log.handle.close();
      throw error;
    }
    for (const log of opened.values()) await log.handle.close();
    sources = await listSources(root);
  }
}
/** Whether each opened name is still the file opened under it, and no file was opened under two names. */
async function settled(
  root: string,
  opened: ReadonlyMap<string, OpenLog>,
): Promise<boolean> {
  const identities = new Set<string>();
  for (const [name, log] of opened) {
    if (identities.has(log.identity)) return false;
    identities.add(log.identity);
    const now = await stat(join(root, name)).catch(() => undefined);
    if (!now || `${now.dev}:${now.ino}` !== log.identity) return false;
  }
  return true;
}
/** Takes entries from the windows in time order, at most `lines` that `filter` keeps, advancing each window's position
 * past every row taken, kept or not. */
function nextEntries(
  windows: SourceWindow[],
  lines: number,
  filter: LogFilter,
): TargetLogEntry[] {
  const entries: TargetLogEntry[] = [];
  while (entries.length < lines) {
    for (const window of windows)
      while (window.rows[0] && !window.rows[0].entry)
        window.position.offset = window.rows.shift()!.end;
    const next = windows
      .filter((window) => window.rows[0]?.entry)
      .sort(
        (a, b) =>
          compareEntries(a.rows[0]!.entry!, b.rows[0]!.entry!) ||
          // Within a family an older generation was written first.
          a.source.family.localeCompare(b.source.family) ||
          b.source.generation - a.source.generation,
      )[0];
    if (!next) break;
    const row = next.rows.shift()!;
    next.position.offset = row.end;
    if (matchesLogFilter(row.entry!, filter)) entries.push(row.entry!);
  }
  return entries;
}
function decodeCursor(
  after: string,
  target: string,
): Record<string, LogPosition> {
  try {
    if (after.length > 128000) throw cursorError();
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(after, "base64url").toString("utf8")),
    );
    if (
      cursor.target !== target ||
      Object.keys(cursor.sources).some((name) => !logSource(name))
    )
      throw cursorError();
    return cursor.sources;
  } catch {
    throw cursorError();
  }
}
/** Moves each cursor position to the file that now has its identity: a rotation renames `target.jsonl` to
 * `target.jsonl.1` (and each older generation one number up), and the follow carries on in the renamed file. A position
 * of a rotating family whose file is gone rotated out of retention and is dropped with its unread lines. Any other
 * position stays under its name, so a file replaced or removed underneath the follow, or a log directory that is gone,
 * is reported as the cursor problem it is. */
function rebind(
  opened: ReadonlyMap<string, OpenLog>,
  previous: Record<string, LogPosition>,
  directoryExists: boolean,
): Record<string, LogPosition> {
  const holders = new Map(
    [...opened].map(([name, log]) => [log.identity, name] as const),
  );
  const rebound: Record<string, LogPosition> = {};
  for (const [name, position] of Object.entries(previous)) {
    const holder = holders.get(position.identity);
    if (holder) rebound[holder] = position;
    else if (!directoryExists || !familyRotates(logSource(name)!.family))
      rebound[name] = position;
  }
  return rebound;
}
/** The complete lines of an open file after `previous` (from the start for a file the cursor has not seen), at most the
 * window. Bytes after the last newline are left for the next read, including split UTF-8. Fails LOG_CURSOR when the
 * file is not the one the cursor read or is shorter than the position. */
async function readWindow(
  log: OpenLog,
  source: LogSource,
  previous: LogPosition | undefined,
): Promise<SourceWindow> {
  const { handle: file, identity, size } = log;
  if (previous && (previous.identity !== identity || previous.offset > size))
    throw cursorError();
  const start = previous?.offset ?? 0;
  const bytes = await readAt(
    file,
    start,
    Math.min(LOG_WINDOW_BYTES, size - start),
  );
  let begin = 0;
  const rows: LogRow[] = [];
  let lastTimestamp: string | undefined;
  const record = (line: string | undefined, length: number, end: number) => {
    const parsed =
      line === undefined ? "unreadable" : parseLogRecord(source.family, line);
    const entry =
      parsed === "unreadable" ? unreadableEntry(length, lastTimestamp) : parsed;
    lastTimestamp = entry?.timestamp ?? lastTimestamp;
    rows.push({ end, entry });
  };
  for (
    let newline = bytes.indexOf(10, begin);
    newline !== -1;
    newline = bytes.indexOf(10, begin)
  ) {
    record(
      bytes.subarray(begin, newline).toString("utf8").replace(/\r$/, ""),
      newline - begin,
      start + newline + 1,
    );
    begin = newline + 1;
  }
  // A run longer than the window has no newline inside it: skip to the newline that
  // ends it (or to the end of the file) as one unreadable record rather than stalling.
  if (bytes.length === LOG_WINDOW_BYTES && !rows.length) {
    const skipTo = await nextNewline(file, start + bytes.length, size);
    record(undefined, skipTo - start - 1, skipTo);
  }
  return { source, position: { identity, offset: start }, rows };
}
function compareEntries(a: TargetLogEntry, b: TargetLogEntry): number {
  const left = Date.parse(a.timestamp),
    right = Date.parse(b.timestamp);
  if (!Number.isFinite(left)) return Number.isFinite(right) ? -1 : 0;
  if (!Number.isFinite(right)) return 1;
  return left - right;
}
