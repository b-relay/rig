import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TargetRecord } from "../domain/runtime";
import type { TargetLogEntry } from "../providers/contracts";
import { RigError } from "../domain/errors";

const maximumReadBytes = 4 * 1024 * 1024;
const currentEntry = z.object({
  timestamp: z.string(),
  component: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  line: z.string(),
});
const legacyEvent = z.object({
  timestamp: z.string().optional(),
  event: z.string(),
  component: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
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
type Position = z.infer<typeof positionSchema>;
interface LogRow {
  end: number;
  entry?: TargetLogEntry;
}
interface SourceWindow {
  name: string;
  position: Position;
  end: number;
  rows: LogRow[];
}
const recognized = (name: string) =>
  name === "target.jsonl" ||
  name === "events.jsonl" ||
  /^[a-zA-Z0-9_-]+\.launchd\.log$/.test(name);
const cursorError = () =>
  new RigError(
    "LOG_CURSOR",
    "The Target log cursor is invalid or its files changed.",
    "Read logs again without a cursor.",
  );

/** Read-only current/legacy log view. Cursors belong to this Target and preserve per-source byte identity.
 * Each source reads at most 4 MiB per call; incomplete final lines wait for a later read.
 * A complete record that cannot be parsed, or a run longer than the window, becomes one
 * "unreadable record" entry so reading and following continue past it.
 * Unknown legacy timestamps/streams remain explicit, and diagnostic event details are never rendered.
 */
export async function readTargetLogs(
  target: TargetRecord,
  after: string | undefined,
  lines: number,
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
  const previous = decodeCursor(after, identity);
  let names: string[];
  try {
    names = (await readdir(target.logRoot)).filter(recognized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  const sourceNames = [...new Set([...names, ...Object.keys(previous)])].sort();
  const windows: SourceWindow[] = [];
  for (const name of sourceNames) {
    const window = await readSource(
      target.logRoot,
      name,
      previous[name],
      after === undefined,
    );
    if (window) windows.push(window);
  }
  const entries: TargetLogEntry[] = [];
  if (after === undefined) {
    // Unknown-time legacy sources precede dated history without inventing a chronological position.
    const all = windows.flatMap((window) =>
      window.rows.flatMap((row, index) =>
        row.entry ? [{ entry: row.entry, source: window.name, index }] : [],
      ),
    );
    all.sort(
      (a, b) =>
        compareEntries(a.entry, b.entry) ||
        a.source.localeCompare(b.source) ||
        a.index - b.index,
    );
    entries.push(...all.slice(-lines).map((row) => row.entry));
    for (const window of windows) window.position.offset = window.end;
  } else {
    while (entries.length < lines) {
      for (const window of windows)
        while (window.rows[0] && !window.rows[0].entry)
          window.position.offset = window.rows.shift()!.end;
      const next = windows
        .filter((window) => window.rows[0]?.entry)
        .sort(
          (a, b) =>
            compareEntries(a.rows[0]!.entry!, b.rows[0]!.entry!) ||
            a.name.localeCompare(b.name),
        )[0];
      if (!next) break;
      const row = next.rows.shift()!;
      entries.push(row.entry!);
      next.position.offset = row.end;
    }
  }
  const sources = Object.fromEntries(
    windows.map((window) => [window.name, window.position]),
  );
  return {
    entries,
    cursor: Buffer.from(
      JSON.stringify({ version: 1, target: identity, sources }),
    ).toString("base64url"),
  };
}
function decodeCursor(
  after: string | undefined,
  target: string,
): Record<string, Position> {
  if (after === undefined) return {};
  try {
    if (after.length > 128000) throw cursorError();
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(after, "base64url").toString("utf8")),
    );
    if (
      cursor.target !== target ||
      Object.keys(cursor.sources).some((name) => !recognized(name))
    )
      throw cursorError();
    return cursor.sources;
  } catch {
    throw cursorError();
  }
}
/** Filesystem adapter retains bytes after the last newline for the next read, including split UTF-8. */
async function readSource(
  root: string,
  name: string,
  previous: Position | undefined,
  recent: boolean,
): Promise<SourceWindow | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(join(root, name), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !previous)
      return undefined;
    throw cursorError();
  }
  try {
    const metadata = await file.stat();
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (
      !metadata.isFile() ||
      (previous &&
        (previous.identity !== identity || previous.offset > metadata.size))
    )
      throw cursorError();
    const start = recent
      ? Math.max(0, metadata.size - maximumReadBytes)
      : (previous?.offset ?? 0);
    const buffer = Buffer.alloc(
      Math.min(maximumReadBytes, metadata.size - start),
    );
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    let begin = recent && start > 0 ? bytes.indexOf(10) + 1 : 0;
    let end = start + begin;
    const rows: LogRow[] = [];
    let lastTimestamp: string | undefined;
    const record = (line: string, size: number, at: number) => {
      const entry = parseLine(name, line, size, lastTimestamp);
      lastTimestamp = entry?.timestamp ?? lastTimestamp;
      end = at;
      rows.push({ end, entry });
    };
    for (
      let newline = bytes.indexOf(10, begin);
      newline !== -1;
      newline = bytes.indexOf(10, begin)
    ) {
      const line = bytes
        .subarray(begin, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      record(line, newline - begin, start + newline + 1);
      begin = newline + 1;
    }
    // A run longer than the window has no newline inside it: skip to the newline that
    // ends it (or to the end of the file) as one unreadable record rather than stalling.
    if (bytesRead === maximumReadBytes && !rows.length) {
      const skipTo = await nextNewline(file, start + bytesRead, metadata.size);
      record("", skipTo - start - 1, skipTo);
      end = skipTo;
    }
    return {
      name,
      position: { identity, offset: previous?.offset ?? start },
      end,
      rows,
    };
  } finally {
    await file.close();
  }
}
/** Byte offset just past the next newline at or after `from`, or the file size when none follows. */
async function nextNewline(
  file: Awaited<ReturnType<typeof open>>,
  from: number,
  size: number,
): Promise<number> {
  const chunk = Buffer.alloc(maximumReadBytes);
  for (let at = from; at < size;) {
    const { bytesRead } = await file.read(chunk, 0, chunk.length, at);
    if (bytesRead === 0) break;
    const newline = chunk.subarray(0, bytesRead).indexOf(10);
    if (newline !== -1) return at + newline + 1;
    at += bytesRead;
  }
  return size;
}
/** A complete record that cannot be read is reported in place, at the last known time, so nothing after it is hidden. */
function unreadable(
  size: number,
  timestamp: string | undefined,
): TargetLogEntry {
  return {
    timestamp: timestamp ?? "unknown",
    component: "unknown",
    stream: "unknown",
    line: `Rig skipped an unreadable log record (${size} bytes).`,
  };
}
function parseLine(
  name: string,
  line: string,
  size: number,
  lastTimestamp: string | undefined,
): TargetLogEntry | undefined {
  if (name.endsWith(".launchd.log"))
    return {
      timestamp: "unknown",
      component: name.slice(0, -".launchd.log".length),
      stream: "unknown",
      line,
    };
  try {
    if (name === "target.jsonl") return currentEntry.parse(JSON.parse(line));
    const event = legacyEvent.parse(JSON.parse(line));
    if (
      event.event !== "component.log" ||
      typeof event.details?.line !== "string"
    )
      return undefined;
    return {
      timestamp: event.timestamp ?? "unknown",
      component: event.component ?? "unknown",
      stream:
        event.details.stream === "stdout" || event.details.stream === "stderr"
          ? event.details.stream
          : "unknown",
      line: event.details.line,
    };
  } catch {
    return unreadable(size, lastTimestamp);
  }
}
function compareEntries(a: TargetLogEntry, b: TargetLogEntry): number {
  const left = Date.parse(a.timestamp),
    right = Date.parse(b.timestamp);
  if (!Number.isFinite(left)) return Number.isFinite(right) ? -1 : 0;
  if (!Number.isFinite(right)) return 1;
  return left - right;
}
