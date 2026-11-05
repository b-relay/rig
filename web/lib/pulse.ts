import type { Outcome } from "./outcome";
import type { ActivityResult, DaemonHealth, QueueResult } from "./types";

/** What the pulse looks at: the three cheapest reads that move whenever a page would show something new. */
export interface PulseReadings {
  health: Outcome<DaemonHealth>;
  queue: Outcome<QueueResult>;
  activity: Outcome<ActivityResult>;
}
/** What the browser learns from one pulse. */
export interface Pulse {
  /** Changes whenever rigd's record changed in a way a page would show; opaque otherwise. */
  stamp: string;
  /** rigd is in the middle of an Operation, so the pages it touches change from tick to tick. */
  busy: boolean;
  /** rigd is away. A page read now could only say so, in place of what the page last read. */
  down: boolean;
}
/** Pure: whether a failed read means rigd is away for now, which it comes back from, rather than a fault that needs someone
 * to act: anything else, such as a reply it should not have sent, is for a page to show. */
export const rigdAway = (code: string): boolean =>
  [
    "DAEMON_MISSING",
    "DAEMON_UNREACHABLE",
    "DAEMON_TIMEOUT",
    "DAEMON_INTERRUPTED",
  ].includes(code);
/** Pure: whether an Operation is a command someone asked for, not rigd's own brief supervision passes. */
export const isCommand = (operation: { action: string }): boolean =>
  operation.action !== "supervise" && operation.action !== "reconcile";
/** Pure: a stamp from rigd's identity, its queue and its newest recorded Operation. A restarted
 * rigd, a started or finished Operation, or a crash rigd recorded each change it; a page whose
 * stamp is unchanged has nothing new to draw. */
export function pulseStamp(readings: PulseReadings): Pulse {
  const daemon = readings.health.ok
    ? `${readings.health.value.instanceId}:${readings.health.value.pid}`
    : `down:${readings.health.failure.code}`;
  const running = readings.queue.ok ? readings.queue.value.running : undefined;
  // Several Operations run at once on different Targets; each one starting, finishing or changing phase (a Target
  // beginning to stop) is news. rigd's own brief supervision passes are not.
  const commands = readings.queue.ok
    ? (readings.queue.value.operations ?? []).filter(isCommand)
    : [];
  const queue = readings.queue.ok
    ? `${
        commands
          .map((operation) => `${operation.operationId}/${operation.phase}`)
          .join(",") ||
        (running?.operationId ?? "-")
      }:${readings.queue.value.waiting}:${readings.queue.value.draining ?? ""}`
    : "?";
  const operations = readings.activity.ok
    ? readings.activity.value.operations
    : [];
  const newest = operations.reduce<string>(
    (latest, operation) =>
      operation.occurredAt > latest ? operation.occurredAt : latest,
    "",
  );
  const activity = readings.activity.ok
    ? `${operations.length}:${newest}`
    : "?";
  return {
    stamp: `${daemon}|${queue}|${activity}`,
    busy: running !== undefined || commands.length > 0,
    down: !readings.health.ok && rigdAway(readings.health.failure.code),
  };
}
/** Pure: whether a pulse redraws the page. A redraw while rigd is down would replace the page, and whatever it holds that
 * its server data cannot bring back (a log view's lines and cursor), with a failure; the page stays until rigd answers,
 * and its stamp then says it changed. Otherwise: a changed stamp, a running Operation, or a long quiet spell. */
export function redrawDue(
  pulse: Pulse,
  seen: { stamp: string | undefined; inFlight: number; stale: boolean },
): boolean {
  if (pulse.down) return false;
  return (
    pulse.stamp !== seen.stamp || pulse.busy || seen.inFlight > 0 || seen.stale
  );
}
