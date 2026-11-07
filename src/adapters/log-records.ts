import { z } from "zod";
import type { TargetLogEntry } from "../providers/contracts";
import { familyEvidence } from "./log-sources";
import type { LogFilter } from "../domain/log-filter";

/** One record of `target.jsonl`, as `appendTargetLogEntries` writes it. */
const currentEntry = z.object({
  timestamp: z.string().describe("When the line was written (ISO 8601)."),
  component: z.string().describe("The Service, Tool or job that wrote it."),
  stream: z
    .enum(["stdout", "stderr", "health"])
    .describe("stdout or stderr output, or health-check evidence."),
  line: z.string().describe("The line, without its newline."),
});
/** One record of an older JSONL log family: an event, of which only `component.log` holds output. */
const legacyEvent = z.object({
  timestamp: z
    .string()
    .optional()
    .describe("When it was written (ISO 8601); absent reads as unknown."),
  event: z
    .string()
    .describe("What the record is; only component.log holds an output line."),
  component: z
    .string()
    .optional()
    .describe("The component that wrote it; absent reads as unknown."),
  details: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The event's details: a component.log event's line and stream; nothing else is shown.",
    ),
});

/** One complete line of a family's file, read: an entry; `unreadable` for a record that cannot be parsed, which the
 * reader reports in place; undefined for an empty line of a family of records, or a legacy event that is not output, which
 * are never shown. Plain-text families (launchd's files) have no times, so their entries carry `unknown`. */
export function parseLogRecord(
  family: string,
  line: string,
): TargetLogEntry | "unreadable" | undefined {
  const plain = familyEvidence(family);
  if (plain) return { timestamp: "unknown", ...plain, line };
  // Two writers that both found a record cut short each end it, which leaves an empty line between: no record at all.
  if (!line) return undefined;
  // Every record is a JSON object; anything else is unreadable without the cost of a parse failure.
  if (!line.trimStart().startsWith("{")) return "unreadable";
  try {
    if (family === "target.jsonl") return currentEntry.parse(JSON.parse(line));
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
    return "unreadable";
  }
}

/** A complete record that cannot be read, reported in place at the time of the readable record before it (`unknown`
 * when there is none) so nothing after it is hidden. `size` is its length in bytes, or with `atLeast`, a lower bound. */
export function unreadableEntry(
  size: number,
  timestamp: string | undefined,
  atLeast = false,
): TargetLogEntry {
  return {
    timestamp: timestamp ?? "unknown",
    component: "unknown",
    stream: "unknown",
    line: `Rig skipped an unreadable log record (${atLeast ? "more than " : ""}${size} bytes).`,
  };
}

/** What every record of `family` that `filter` keeps holds in its bytes, so a reader can pass over the lines without
 * one unparsed: for each group, one of its byte strings. Rig writes each record of `target.jsonl` with JSON.stringify
 * (see `appendTargetLogEntries`), so a record of component `web` holds `"component":"web"` and one of stdout
 * `"stream":"stdout"`. A line that holds them may still not match and is parsed as usual. Undefined when `filter` names
 * neither components nor a stream, or `family` is not `target.jsonl`: every line is read. */
export function recordMarkers(
  family: string,
  filter: LogFilter,
): RecordMarkers | undefined {
  if (family !== "target.jsonl") return undefined;
  const groups: Buffer[][] = [];
  if (filter.services)
    groups.push(
      filter.services.map((name) =>
        Buffer.from(`"component":${JSON.stringify(name)}`),
      ),
    );
  if (filter.stream)
    groups.push([Buffer.from(`"stream":${JSON.stringify(filter.stream)}`)]);
  return groups.length ? groups : undefined;
}
const TIME_PREFIX = Buffer.from('{"timestamp":"');
/** The time of a record of `target.jsonl` read from its bytes without parsing it: Rig writes `timestamp` first (see
 * `appendTargetLogEntries`). Undefined for a line that does not start that way, or whose time holds an escape. */
export function recordTime(bytes: Buffer): string | undefined {
  if (
    bytes.length < TIME_PREFIX.length ||
    TIME_PREFIX.compare(bytes, 0, TIME_PREFIX.length) !== 0
  )
    return undefined;
  const close = bytes.indexOf(34, TIME_PREFIX.length);
  if (close === -1) return undefined;
  const time = bytes.toString("latin1", TIME_PREFIX.length, close);
  return time.includes("\\") ? undefined : time;
}
/** Groups of byte strings; see `recordMarkers`. */
export type RecordMarkers = readonly (readonly Buffer[])[];
/** Whether `bytes` hold one byte string of every group of `markers`. */
export function holdsMarkers(bytes: Buffer, markers: RecordMarkers): boolean {
  return markers.every((group) =>
    group.some((marker) => bytes.includes(marker)),
  );
}
