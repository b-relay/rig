import { z } from "zod";
import type { TargetLogEntry } from "../providers/contracts";
import { familyEvidence } from "./log-sources";

const currentEntry = z.object({
  timestamp: z.string(),
  component: z.string(),
  stream: z.enum(["stdout", "stderr", "health"]),
  line: z.string(),
});
const legacyEvent = z.object({
  timestamp: z.string().optional(),
  event: z.string(),
  component: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** One complete line of a family's file, read: an entry; `unreadable` for a record that cannot be parsed, which the
 * reader reports in place; undefined for a legacy event that is not output and is never shown. Plain-text families
 * (launchd's files) have no times, so their entries carry `unknown`. */
export function parseLogRecord(
  family: string,
  line: string,
): TargetLogEntry | "unreadable" | undefined {
  const plain = familyEvidence(family);
  if (plain) return { timestamp: "unknown", ...plain, line };
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
 * when there is none) so nothing after it is hidden. `size` is its length in bytes. */
export function unreadableEntry(
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
