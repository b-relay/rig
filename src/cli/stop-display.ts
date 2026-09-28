import type { ServiceStop } from "../daemon/protocol";

/** How a stop reads while rig waits on it: pure text from rigd's view of the stop and the local clock, so a log read later
 * still makes sense (every deadline is shown as local time as well as time left). */

/** A stop is shown once it has waited this long; a Service that exits at once is never mentioned. */
export const SHOW_STOP_AFTER_MS = 2000;
/** Without a terminal, a waiting stop is repeated this often. */
export const PLAIN_REPEAT_MS = 5 * 60_000;
/** Without a terminal, one more line is printed when this little is left before the kill. */
export const PLAIN_LAST_CALL_MS = 60_000;

/** A duration as people read it. `seconds` keeps every unit down to seconds ("18m 42s"); `minutes` rounds to the nearest
 * minute from one minute up ("25m", "1h 5m") and shows seconds below it ("42s"). Never negative. */
export function formatDuration(
  ms: number,
  precision: "seconds" | "minutes",
): string {
  const total = Math.max(0, ms);
  if (precision === "minutes" && total >= 60_000) {
    const minutes = Math.round(total / 60_000);
    const hours = Math.floor(minutes / 60);
    return hours
      ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
      : `${minutes}m`;
  }
  const seconds = Math.round(total / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}
/** The local wall-clock time of `at`, as HH:MM or HH:MM:SS. */
export function formatClock(at: Date, withSeconds: boolean): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    at.getHours(),
    at.getMinutes(),
    ...(withSeconds ? [at.getSeconds()] : []),
  ]
    .map(pad)
    .join(":");
}
/** Whether rig shows `stop` yet: it has waited SHOW_STOP_AFTER_MS, or it has ended after waiting that long. */
export function stopVisible(stop: ServiceStop, now: Date): boolean {
  const ended = stop.endedAt ? Date.parse(stop.endedAt) : now.getTime();
  return ended - Date.parse(stop.since) >= SHOW_STOP_AFTER_MS;
}
/** What a stopping Service is waiting for, e.g. `killing in 18m 42s (04:31:07)`, or `killing now` once it is due. `left`
 * is the precision of the time left; the clock shows seconds when `clockSeconds`. */
export function killingText(
  killAt: string,
  now: Date,
  left: "seconds" | "minutes",
  clockSeconds: boolean,
): string {
  const remaining = Date.parse(killAt) - now.getTime();
  if (remaining <= 0) return "killing now";
  return `killing in ${formatDuration(remaining, left)} (${formatClock(new Date(killAt), clockSeconds)})`;
}
/** How a Service's stop ended, after how long. */
export function endedText(stop: ServiceStop): string {
  const after = formatDuration(
    Date.parse(stop.endedAt ?? stop.since) - Date.parse(stop.since),
    "seconds",
  );
  if (stop.state === "failed")
    return `could not be verified stopped after ${after}`;
  if (stop.killed === "timeout")
    return `stopped after timeout (SIGKILL) after ${after}`;
  if (stop.killed === "request")
    return `killed by --kill (SIGKILL) after ${after}`;
  return `stopped after ${after}`;
}

/** The TTY board: a heading per Target, one line per Service with its state, and while any is stopping the Ctrl-C hint.
 * Only stops that are visible are listed, in the order they began. */
export function stopBoard(
  project: string | undefined,
  stops: readonly ServiceStop[],
  now: Date,
  /** The command ended while these were still stopping: they are shown as left to rigd, without a countdown or hint. */
  abandoned = false,
): string[] {
  // Nothing until a stop has waited a while; then every Service already stopped is listed beside it.
  if (!stops.some((stop) => stopVisible(stop, now))) return [];
  const shown = stops.filter(
    (stop) => stop.state !== "stopping" || stopVisible(stop, now),
  );
  const width = Math.max(...shown.map((stop) => stop.service.length)) + 4;
  const lines: string[] = [];
  let heading: string | undefined;
  for (const stop of shown) {
    const title = ["Stopping", project, stop.target].filter(Boolean).join(" ");
    if (title !== heading) lines.push((heading = title));
    const state =
      stop.state === "stopping"
        ? abandoned
          ? `still stopping in rigd (killing at ${formatClock(new Date(stop.killAt), true)})`
          : `stopping · ${killingText(stop.killAt, now, "seconds", true)}`
        : stop.state === "failed"
          ? "could not be verified stopped"
          : stop.killed === "timeout"
            ? "stopped after timeout (SIGKILL)"
            : stop.killed === "request"
              ? "killed (SIGKILL)"
              : "stopped";
    lines.push(`  ${stop.service.padEnd(width)}${state}`);
  }
  if (!abandoned && shown.some((stop) => stop.state === "stopping"))
    lines.push("  (Ctrl-C to leave it stopping in the background)");
  return lines;
}

/** What has been printed about one stop without a terminal. */
export interface PlainStopState {
  /** When the stop began, as rigd reported it: a different one is a new stop of the same Service. */
  since: string;
  /** When its last waiting line was printed, and how long was left then. */
  printedAt: number;
  leftThen: number;
  ended: boolean;
}
/** The appended lines rig prints without a terminal: one when a stop becomes visible, one every PLAIN_REPEAT_MS, one when
 * PLAIN_LAST_CALL_MS are left (unless the last line already said less), and one when it ends. `printed` remembers what
 * was said, by Target and Service; the caller keeps it across calls. */
export function plainStopLines(
  printed: Map<string, PlainStopState>,
  stops: readonly ServiceStop[],
  now: Date,
): string[] {
  const lines: string[] = [];
  for (const stop of stops) {
    const key = `${stop.target}\u0000${stop.service}`;
    const seen = printed.get(key);
    // A stop begun again (a rollback stopping the same Service) starts its own lines, even when the earlier one's end was
    // never seen between two polls.
    const fresh =
      seen &&
      stop.state === "stopping" &&
      (seen.ended || seen.since !== stop.since);
    if (!stopVisible(stop, now)) continue;
    const left = Date.parse(stop.killAt) - now.getTime();
    const waiting = `${stop.service} stopping, ${killingText(stop.killAt, now, "minutes", true)}`;
    if (!seen || fresh) {
      if (stop.state === "stopping") {
        lines.push(waiting);
        printed.set(key, {
          since: stop.since,
          printedAt: now.getTime(),
          leftThen: left,
          ended: false,
        });
      }
      continue;
    }
    if (seen.ended) continue;
    if (stop.state !== "stopping") {
      lines.push(`${stop.service} ${endedText(stop)}`);
      seen.ended = true;
      continue;
    }
    if (
      now.getTime() - seen.printedAt >= PLAIN_REPEAT_MS ||
      (left <= PLAIN_LAST_CALL_MS &&
        seen.leftThen > PLAIN_LAST_CALL_MS &&
        left > 0)
    ) {
      lines.push(waiting);
      seen.printedAt = now.getTime();
      seen.leftThen = left;
    }
  }
  return lines;
}
/** The Services still stopping among the ones shown, for the Ctrl-C message. */
export function visibleStopping(
  stops: readonly ServiceStop[],
  now: Date,
): ServiceStop[] {
  return stops.filter(
    (stop) => stop.state === "stopping" && stopVisible(stop, now),
  );
}
