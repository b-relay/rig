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
}
/** Pure: a stamp from rigd's identity, its queue and its newest recorded Operation. A restarted
 * rigd, a started or finished Operation, or a crash rigd recorded each change it; a page whose
 * stamp is unchanged has nothing new to draw. */
export function pulseStamp(readings: PulseReadings): Pulse {
  const daemon = readings.health.ok
    ? `${readings.health.value.instanceId}:${readings.health.value.pid}`
    : `down:${readings.health.failure.code}`;
  const running = readings.queue.ok ? readings.queue.value.running : undefined;
  const queue = readings.queue.ok
    ? `${running?.operationId ?? "-"}:${readings.queue.value.waiting}`
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
    busy: running !== undefined,
  };
}
