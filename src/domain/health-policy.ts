/** Ongoing health checks (ADR 0012): the pure rules for what one check result means, and when an unhealthy Service with
 * `on_failure: restart` is restarted. Times are the wall-clock instants things happened, in Unix milliseconds; how long
 * ago one was is elapsed time, which a `since` function given here measures (`Clock.since`), so nothing here reads a clock
 * and a correction of the clock never moves a check or a restart. */

/** Milliseconds elapsed since a wall-clock instant. */
export type Since = (at: number) => number;

/** A Service's ongoing check policy, as its plan records it, in milliseconds. */
export interface HealthPolicy {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  /** Failed checks in a row before the Service is unhealthy. */
  readonly retries: number;
  readonly onFailure: "report" | "restart";
}
/** One unhealthy stretch of a Service: from the check that reached `retries` until a check passes again, across any health
 * restarts in between. */
export interface HealthStretch {
  /** When the Service became unhealthy. */
  readonly since: number;
  /** When each health restart of this stretch was made, oldest first. */
  readonly restarts: readonly number[];
}
/** What Rig knows of one Service's ongoing checks. */
export interface HealthState {
  /** The process the checks are about; another one starts the count again. */
  readonly incarnation?: string;
  /** Which check the results are about (the plan's test and policy, as the monitor names them); another starts afresh. */
  readonly check?: string;
  /** Since when this process may be checked: its start check passed and nothing is starting or stopping its Target. */
  readonly eligibleSince?: number;
  readonly checkedAt?: number;
  readonly passed?: boolean;
  /** The last failed check's output, bounded. */
  readonly output?: string;
  /** Failed checks in a row. */
  readonly failures: number;
  /** Set while the Service is unhealthy. */
  readonly stretch?: HealthStretch;
}
export const NEW_HEALTH: HealthState = { failures: 0 };
/** The pause before each health restart after the first of one unhealthy stretch: 1 min, 5 min, 15 min, then hourly. The
 * first is made as soon as the Service becomes unhealthy. */
export const HEALTH_RESTART_BACKOFF_MS = [
  60_000, 300_000, 900_000, 3_600_000,
] as const;
/** How much of a check's output Rig keeps, shows and records. */
export const HEALTH_OUTPUT_LIMIT = 200;

/** The output as Rig keeps it: one line, at most HEALTH_OUTPUT_LIMIT characters, ending in … when cut. */
export function boundedOutput(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > HEALTH_OUTPUT_LIMIT
    ? `${line.slice(0, HEALTH_OUTPUT_LIMIT - 1)}…`
    : line;
}
/** Whether the next check of a Service is due: once it may be checked, at once for a process not checked yet, then once
 * `interval` has elapsed since the last check. */
export function checkDue(
  state: HealthState,
  policy: Pick<HealthPolicy, "intervalMs">,
  since: Since,
): boolean {
  return (
    state.eligibleSince !== undefined &&
    (state.checkedAt === undefined ||
      since(state.checkedAt) >= policy.intervalMs)
  );
}
/** A change a check result makes that Activity records. */
export type HealthEvent = "unhealthy" | "recovered";
/** One check result applied: a pass ends an unhealthy stretch and clears the count; a failure counts, and the one that
 * reaches `retries` makes the Service unhealthy. */
export function recordCheck(
  state: HealthState,
  result: { passed: boolean; output?: string },
  at: number,
  policy: Pick<HealthPolicy, "retries">,
): { state: HealthState; event?: HealthEvent } {
  if (result.passed) {
    const { output: _output, stretch, ...rest } = state;
    return {
      state: { ...rest, checkedAt: at, passed: true, failures: 0 },
      ...(stretch ? { event: "recovered" as const } : {}),
    };
  }
  const failures = state.failures + 1;
  const marked = failures >= policy.retries && !state.stretch;
  return {
    state: {
      ...state,
      checkedAt: at,
      passed: false,
      failures,
      ...(result.output !== undefined
        ? { output: boundedOutput(result.output) }
        : {}),
      ...(marked ? { stretch: { since: at, restarts: [] } } : {}),
    },
    ...(marked ? { event: "unhealthy" as const } : {}),
  };
}
/** Whether the Service is unhealthy: its failures reached `retries` and no check has passed since, across any health restart
 * in between. */
export function isUnhealthy(state: HealthState): boolean {
  return state.stretch !== undefined;
}
/** What Rig does about an unhealthy Service now: nothing (it only reports, it is healthy, or the process a restart started
 * has not failed `retries` checks yet), restart it, or wait until the back-off allows the next restart. */
export type HealthAction =
  | { kind: "none" }
  | { kind: "restart"; attempt: number }
  | { kind: "wait"; ms: number };
export function healthAction(
  state: HealthState,
  policy: HealthPolicy,
  since: Since,
): HealthAction {
  const stretch = state.stretch;
  if (policy.onFailure !== "restart" || !stretch) return { kind: "none" };
  if (state.passed !== false || state.failures < policy.retries)
    return { kind: "none" };
  const wait = healthRestartWait(stretch, since);
  return wait <= 0
    ? { kind: "restart", attempt: stretch.restarts.length + 1 }
    : { kind: "wait", ms: wait };
}
/** The back-off before the next health restart of an unhealthy stretch: none before the first, then the step for the
 * restarts made so far. */
function healthRestartBackoff(stretch: HealthStretch): number {
  return stretch.restarts.length === 0
    ? 0
    : HEALTH_RESTART_BACKOFF_MS[
        Math.min(
          stretch.restarts.length - 1,
          HEALTH_RESTART_BACKOFF_MS.length - 1,
        )
      ]!;
}
/** When the next health restart of an unhealthy stretch is due, as a wall-clock time to show: at once for the first, then
 * the back-off after the last. Whether it is due is `healthRestartWait`'s to say. */
export function healthRestartDueAt(stretch: HealthStretch): number {
  return (
    (stretch.restarts.at(-1) ?? stretch.since) + healthRestartBackoff(stretch)
  );
}
/** How much longer the next health restart of an unhealthy stretch waits, in milliseconds; zero or less once it is due. */
export function healthRestartWait(
  stretch: HealthStretch,
  since: Since,
): number {
  return (
    healthRestartBackoff(stretch) -
    since(stretch.restarts.at(-1) ?? stretch.since)
  );
}
/** The state after a health restart was attempted at `at`: the stretch goes on and counts the attempt, and the count starts
 * again. It still names the process that was judged, so a new one is recognized when it is seen, and one whose stop failed
 * is not mistaken for a new one. */
export function restarted(state: HealthState, at: number): HealthState {
  const stretch = state.stretch ?? { since: at, restarts: [] };
  const { eligibleSince: _next, ...rest } = state;
  return {
    ...rest,
    failures: 0,
    stretch: { ...stretch, restarts: [...stretch.restarts, at] },
  };
}
