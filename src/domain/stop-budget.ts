import { RigError } from "./errors";

/** How long a Service may take to stop, and every wait on the stop path derived from it. A Service's `stop_timeout` is the one
 * source: the capture wrapper's grace for its application, rigd's wait for the wrapper, launchd's ExitTimeOut and the
 * launchd unload wait all follow from it, so no outer layer kills the wrapper before the application's grace can finish. */

/** The grace a Service gets when its config sets no `stop_timeout`: 10 s. */
export const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
/** The longest `stop_timeout` config accepts: one hour. */
export const MAX_STOP_TIMEOUT_SECONDS = 3600;
/** The fixed parts of every stop budget besides the grace. The platform uses `PLATFORM_STOP_TIMINGS`; a test passes smaller
 * ones so its budgets expire quickly. */
export interface StopTimings {
  /** How long a SIGKILLed process group may take to disappear before the stop fails. */
  readonly killWaitMs: number;
  /** What a capture wrapper needs beyond its application's grace and kill wait to finish: output drains, its exit record,
   * its own shutdown, and the latency of whoever watches it. */
  readonly headroomMs: number;
}
export const PLATFORM_STOP_TIMINGS: StopTimings = {
  killWaitMs: 1500,
  headroomMs: 2000,
};
/** Every wait of one stop, in milliseconds except `exitTimeOutSeconds`. */
export interface StopBudget {
  /** The application's grace after SIGTERM before SIGKILL: its `stop_timeout`. */
  readonly graceMs: number;
  readonly killWaitMs: number;
  /** How long a supervisor waits for a capture wrapper after SIGTERM before it kills the wrapper: the application's grace,
   * its kill wait, and headroom. */
  readonly wrapperMs: number;
  /** How long a supervisor waits for a capture wrapper after it asked for a kill: the wrapper's own kill wait, the
   * application's kill wait, and headroom. */
  readonly killedWrapperMs: number;
  /** The launchd plist's ExitTimeOut: launchd's wait for the wrapper after SIGTERM, in whole seconds, never less than
   * `wrapperMs`, and at least 1 (launchd reads 0 as forever). */
  readonly exitTimeOutSeconds: number;
  /** How long the launchd supervisor waits for a booted-out job to leave: launchd's ExitTimeOut, then its SIGKILL's
   * kill wait, and headroom for launchctl. */
  readonly unloadMs: number;
}
/** The budget of a stop whose application has `graceMs` to exit after SIGTERM. */
export function stopBudget(
  graceMs: number,
  timings: StopTimings = PLATFORM_STOP_TIMINGS,
): StopBudget {
  const wrapperMs = graceMs + timings.killWaitMs + timings.headroomMs;
  const exitTimeOutSeconds = Math.max(1, Math.ceil(wrapperMs / 1000));
  return {
    graceMs,
    killWaitMs: timings.killWaitMs,
    wrapperMs,
    killedWrapperMs: 2 * timings.killWaitMs + timings.headroomMs,
    exitTimeOutSeconds,
    unloadMs:
      exitTimeOutSeconds * 1000 + timings.killWaitMs + timings.headroomMs,
  };
}
/** A Service's grace in milliseconds from the seconds its recorded plan holds; a plan recorded before `stop_timeout`
 * existed has none and gets the default. */
export function serviceGraceMs(stopTimeoutSeconds: number | undefined): number {
  return (stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS) * 1000;
}
/** A stop that stopped waiting because rigd is shutting down: the process was asked to stop and finishes on its own, and
 * the next daemon finds the stop and completes it. */
export function stopDetached(details: Record<string, unknown> = {}): RigError {
  return new RigError(
    "STOP_DETACHED",
    "rigd stopped while it waited for a Service to exit; the Service keeps stopping on its own.",
    "Run rig status once rigd is back to see where the Target stands, then run the command again, or rig down <target> --kill, to finish it. A Target recorded as stopped is stopped again by the next rigd.",
    details,
  );
}
/** Never throws, even for a thrown value whose prototype or fields cannot be read. */
export function isStopDetached(error: unknown): boolean {
  try {
    return error instanceof RigError && error.code === "STOP_DETACHED";
  } catch {
    return false;
  }
}
