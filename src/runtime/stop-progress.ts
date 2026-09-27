import type {
  OperationPhase,
  OperationView,
  ServiceStopView,
} from "../domain/operation-progress";
import type { TargetRecord } from "../domain/runtime";
import { PLATFORM_STOP_TIMINGS } from "../domain/stop-budget";
import type { StopObserver } from "./lifecycle";

/** What rigd keeps about one running Operation's stops: the view commands and status read, the Target it works on, the
 * kill that cuts its graces short, and the phase a stop interrupted. */
export interface StopTracking {
  view: OperationView;
  targetId?: string;
  /** Aborted by the Operation's own `--kill`, or by a later `--kill` on the Target it is stopping. */
  kill: AbortController;
  /** The phase to return to once the stops that interrupted it have ended. */
  resumePhase?: OperationPhase;
}

/** Shows each stop of `entry` on its view as the lifecycle reports it. The Operation's phase is `stopping` while any of
 * its Services is stopping, and returns to what it was once they have all ended (a deploy goes on deploying). `now` is
 * rigd's clock in ISO 8601; a Service's SIGKILL is due its grace after the stop began, or the kill wait once killed. */
export function stopObserver(
  entry: StopTracking,
  now: () => string,
  killWaitMs = PLATFORM_STOP_TIMINGS.killWaitMs,
): StopObserver {
  return {
    stopping(target, service, graceMs) {
      const since = now();
      const wait = entry.kill.signal.aborted ? killWaitMs : graceMs;
      entry.targetId = target.id;
      if (entry.view.phase !== "stopping") {
        entry.resumePhase = entry.view.phase;
        entry.view.phase = "stopping";
      }
      const stops = (entry.view.stops ?? []).filter(
        (stop) => !(stop.service === service && stop.target === target.name),
      );
      stops.push({
        service,
        target: target.name,
        state: "stopping",
        since,
        killAt: new Date(Date.parse(since) + wait).toISOString(),
      });
      entry.view.stops = stops;
    },
    stopped(target, service, ended) {
      const stops = entry.view.stops ?? [];
      const index = stops.findIndex(
        (stop) => stop.service === service && stop.target === target.name,
      );
      if (index >= 0) {
        // A Service that was not running had nothing to wait for and is not shown.
        if (ended.outcome === "unchanged") stops.splice(index, 1);
        else
          stops[index] = {
            ...stops[index]!,
            state: ended.outcome === "failed" ? "failed" : "stopped",
            endedAt: now(),
            ...("killed" in ended && ended.killed
              ? { killed: ended.killed }
              : {}),
          };
      }
      if (
        !stops.some((stop) => stop.state === "stopping") &&
        entry.resumePhase
      ) {
        entry.view.phase = entry.resumePhase;
        delete entry.resumePhase;
      }
    },
  };
}

/** A `--kill` for the Target `targetId`: every Operation stopping it has its remaining graces cut to the kill wait, and its
 * stopping Services show the earlier SIGKILL. Operations on the Target doing something else are left alone. */
export function killStops(
  entries: Iterable<StopTracking>,
  targetId: string,
  now: string,
  killWaitMs = PLATFORM_STOP_TIMINGS.killWaitMs,
): void {
  const due = Date.parse(now) + killWaitMs;
  for (const entry of entries) {
    if (entry.targetId !== targetId || entry.view.phase !== "stopping")
      continue;
    entry.kill.abort();
    for (const stop of entry.view.stops ?? [])
      if (stop.state === "stopping" && Date.parse(stop.killAt) > due)
        stop.killAt = new Date(due).toISOString();
  }
}

/** The Services of Target `targetId` that some Operation is waiting on right now. */
export function activeStops(
  entries: Iterable<StopTracking>,
  targetId: string,
): ServiceStopView[] {
  return [...entries].flatMap((entry) =>
    entry.targetId === targetId
      ? (entry.view.stops ?? []).filter((stop) => stop.state === "stopping")
      : [],
  );
}

/** How Activity says a Service needed SIGKILL. */
export function stopKillText(
  stop: Pick<ServiceStopView, "service" | "killed">,
): string {
  return stop.killed === "request"
    ? `${stop.service} was killed by --kill (SIGKILL)`
    : `${stop.service} stopped after timeout (SIGKILL)`;
}

/** Activity's line for the Services an Operation had to SIGKILL; undefined when none. */
export function killedMessage(view: OperationView): string | undefined {
  const killed = (view.stops ?? []).filter((stop) => stop.killed);
  return killed.length ? killed.map(stopKillText).join("; ") : undefined;
}

/** Records on `target` which Services its operator's stop had to SIGKILL, so status can say so until the next start.
 * Updates `target` in place; the caller saves it. Returns whether anything changed. */
export function recordStopKills(
  target: TargetRecord,
  view: OperationView,
): boolean {
  let changed = false;
  for (const stop of view.stops ?? []) {
    const run = target.services?.[stop.service];
    if (stop.target !== target.name || !stop.killed || !run) continue;
    target.services![stop.service] = { ...run, stopKilled: stop.killed };
    changed = true;
  }
  return changed;
}
