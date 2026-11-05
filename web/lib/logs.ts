import type { ComponentReport, LogsResult, TargetReport } from "./types";

export type LogEntry = LogsResult["entries"][number];
/** A Target whose log can be read, with the names its lines are recorded under. */
export interface LogTarget extends Pick<TargetReport, "name" | "kind"> {
  components: readonly string[];
}
/** Pure: the Target a Project's Logs tab opens on when the address names none: the first, in page
 * order, that has run (a working copy never started has no log yet), else the first. */
export function preferredLogTarget<T extends Pick<TargetReport, "state">>(
  ordered: readonly T[],
): T | undefined {
  return ordered.find((target) => target.state !== "configured") ?? ordered[0];
}
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
/** The line counts the log viewer offers. */
export const LOG_LINE_CHOICES = [100, 200, 1000, 5000] as const;
/** The line count a new view reads, which is the page the server read for its first paint. */
export const FIRST_LOG_LINES = 200;
/** How a reader set up the log viewer. It lives in the page's address, so a reload and a shared link show the same view. */
export interface LogView {
  lines: number;
  follow: boolean;
  query: LogQuery;
  wrap: boolean;
}
/** Pure: the view an address asks for, with `components` the names the Target's lines are recorded under. Anything it does
 * not recognise reads as the default. */
export function logViewOf(
  params: Pick<URLSearchParams, "get" | "getAll">,
  components: readonly string[],
): LogView {
  const lines = Number(params.get("lines"));
  const stream = params.get("stream");
  return {
    lines: (LOG_LINE_CHOICES as readonly number[]).includes(lines)
      ? lines
      : FIRST_LOG_LINES,
    follow: params.get("paused") !== "1",
    query: {
      services: [...new Set(params.getAll("component"))].filter((name) =>
        components.includes(name),
      ),
      ...(stream === "stdout" || stream === "stderr" ? { stream } : {}),
    },
    wrap: params.get("nowrap") !== "1",
  };
}
/** Pure: `params` with `view` written in place of any earlier view, each choice only when it is not the default, so a new
 * view's address stays as it was. Anything else in it, such as the Target, stays. */
export function logViewParams(
  view: LogView,
  params: Iterable<[string, string]>,
): URLSearchParams {
  const next = new URLSearchParams([...params]);
  for (const name of ["lines", "paused", "stream", "component", "nowrap"])
    next.delete(name);
  if (view.lines !== FIRST_LOG_LINES) next.set("lines", String(view.lines));
  if (!view.follow) next.set("paused", "1");
  if (view.query.stream) next.set("stream", view.query.stream);
  for (const name of view.query.services) next.append("component", name);
  if (!view.wrap) next.set("nowrap", "1");
  return next;
}
const SEARCH_KEY = "rig.logs.search:";
/** What this tab last searched on the log page at `path`. A search may be a secret copied from the output, so it stays out
 * of the address and its history; session storage keeps it for a reload, and nothing is kept where storage is refused. */
export function keptLogSearch(path: string): string {
  try {
    return window.sessionStorage.getItem(SEARCH_KEY + path) ?? "";
  } catch {
    return "";
  }
}
/** Keeps `search` for `keptLogSearch`; an empty one keeps nothing. */
export function keepLogSearch(path: string, search: string): void {
  try {
    if (search) window.sessionStorage.setItem(SEARCH_KEY + path, search);
    else window.sessionStorage.removeItem(SEARCH_KEY + path);
  } catch {
    // A reload then opens with no search, as a new view does.
  }
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
