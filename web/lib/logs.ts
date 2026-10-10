import type { ComponentReport, LogsResult } from "./types";

export type LogEntry = LogsResult["entries"][number];
/** What the log viewer asks rigd to narrow a read to; empty means every line. */
export interface LogQuery {
  /** Component names; none means all. */
  services: readonly string[];
  stream?: "stdout" | "stderr";
}
/** Pure: the names a Target's log lines are recorded under, as rigd accepts them in a filter: its
 * Services, then its Tools (build and install output), then `setup` (dependency installation and
 * the shared build). */
export function logComponentChoices(
  components: readonly Pick<ComponentReport, "name" | "kind">[],
): string[] {
  const named = (kind: ComponentReport["kind"]) =>
    components
      .filter((component) => component.kind === kind)
      .map((component) => component.name)
      .sort();
  return [...new Set([...named("managed"), ...named("installed"), "setup"])];
}
/** Pure: the `logFilter` a read carries for `query`, or nothing when it asks for every line. */
export function logFilter(
  query: LogQuery,
): { services?: string[]; stream?: "stdout" | "stderr" } | undefined {
  if (!query.services.length && !query.stream) return undefined;
  return {
    ...(query.services.length ? { services: [...query.services] } : {}),
    ...(query.stream ? { stream: query.stream } : {}),
  };
}
/** Pure: whether a line matches the search box: every word, in any case, in its text or component. */
export function matchesSearch(entry: LogEntry, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${entry.component} ${entry.line}`.toLowerCase();
  return words.every((word) => text.includes(word));
}
/** The marker `rig logs` prints for each stream. */
export const STREAM_MARKER: Record<LogEntry["stream"], string> = {
  stdout: ">",
  stderr: "!",
  health: "~",
  unknown: "?",
};
/** Pure: lines as `rig logs` prints them (`HH:MM:SSZ  <component>  <marker> <line>`), for a download. */
export function logText(entries: readonly LogEntry[]): string {
  return entries
    .map((entry) => {
      const time = /T(\d{2}:\d{2}:\d{2})/.exec(entry.timestamp)?.[1];
      return `${time ? `${time}Z` : entry.timestamp}  ${entry.component}  ${STREAM_MARKER[entry.stream]} ${entry.line}`;
    })
    .join("\n")
    .concat(entries.length ? "\n" : "");
}
const HUES = 6;
/** Pure: a stable colour slot (0 to 5) for a component name, so each Service keeps its colour. */
export function componentSlot(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % HUES;
}
