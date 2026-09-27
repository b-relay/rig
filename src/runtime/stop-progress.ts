import type {
  OperationPhase,
  OperationView,
  ServiceStopView,
} from "../domain/operation-progress";
import type { TargetRecord } from "../domain/runtime";
import { PLATFORM_STOP_TIMINGS } from "../domain/stop-budget";
import type { StopObserver } from "./lifecycle";

/** What rigd keeps about one running Operation's stops: the view commands and status read, the Target it works on, the
 * kills that cut its graces short, and the phase a stop interrupted. */
export interface StopTracking {
  view: OperationView;
  targetId?: string;
  /** The Operation is a `--kill` itself: every stop it makes skips the grace. */
  killAll?: boolean;
  /** One kill per Target the Operation stops Services of, by Target id; aborted by a `--kill` on that Target. */
  kills: Map<string, AbortController>;
  /** The Target a `--kill` Operation asked every stop to be cut short on, while it runs. */
  killing?: string;
  /** The phase to return to once the stops that interrupted it have ended. */
  resumePhase?: OperationPhase;
}
/** The kill `entry`'s stops of Target `targetId` wait on: already aborted when the Operation is a `--kill`, or while a
 * `--kill` for that Target is running (`killRequested`). */
export function killSignal(
  entry: StopTracking,
  targetId: string,
  killRequested: (targetId: string) => boolean,
): AbortSignal {
  let kill = entry.kills.get(targetId);
  if (!kill) entry.kills.set(targetId, (kill = new AbortController()));
  if (entry.killAll || killRequested(targetId)) kill.abort();
  return kill.signal;
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
      const wait = entry.kills.get(target.id)?.signal.aborted
        ? killWaitMs
        : graceMs;
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

/** A `--kill` for `target`: every stop of its Services already running has its remaining grace cut to the kill wait, and
 * shows the earlier SIGKILL. Stops of other Targets the same Operations make are left alone. */
export function killStops(
  entries: Iterable<StopTracking>,
  target: { id: string; name: string },
  now: string,
  killWaitMs = PLATFORM_STOP_TIMINGS.killWaitMs,
): void {
  const due = Date.parse(now) + killWaitMs;
  for (const entry of entries) {
    const kill = entry.kills.get(target.id);
    if (!kill) continue;
    kill.abort();
    for (const stop of entry.view.stops ?? [])
      if (
        stop.target === target.name &&
        stop.state === "stopping" &&
        Date.parse(stop.killAt) > due
      )
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
