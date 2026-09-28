/** Ongoing health checks (#282): the pure rules for what one check result means, and when an unhealthy Service is restarted
 * or given up on. Times are Unix milliseconds; nothing here reads a clock. */

/** A Service's ongoing check policy, as its plan records it, in milliseconds. */
export interface HealthPolicy {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  /** Failed checks in a row before Rig acts. */
  readonly failures: number;
  readonly onFailure: "report" | "restart";
  /** How long Rig keeps restarting a Service that stays unhealthy; forever when absent. */
  readonly retryForMs?: number;
}
/** One unhealthy stretch of a Service: from the check that reached `failures` until a check passes again. */
export interface HealthEpisode {
  /** When the Service was first marked unhealthy in this stretch. */
  readonly since: number;
  /** When each health restart of this stretch was made, oldest first. */
  readonly restarts: readonly number[];
  /** When Rig stopped restarting it because `retry_for` ran out. */
  readonly gaveUp?: number;
}
/** What Rig knows of one Service's ongoing checks. */
export interface HealthState {
  /** The process the checks are about; another one starts the count again. */
  readonly incarnation?: string;
  /** When the checks of this process may begin: its start check has passed and nothing is starting or stopping it. */
  readonly eligibleSince?: number;
  readonly checkedAt?: number;
  readonly passed?: boolean;
  /** The last failed check's output, bounded. */
  readonly output?: string;
  /** Failed checks in a row. */
  readonly failures: number;
  readonly episode?: HealthEpisode;
}
export const NEW_HEALTH: HealthState = { failures: 0 };
/** The pause between health restarts of one unhealthy stretch: about 1 min, 5 min, 15 min, then hourly. The first restart is
 * made as soon as the Service is marked unhealthy. */
export const HEALTH_RESTART_BACKOFF_MS = [
  60_000, 300_000, 900_000, 3_600_000,
] as const;
/** How much of a check's output Rig keeps and records. */
export const HEALTH_OUTPUT_LIMIT = 200;

/** The output as Rig keeps it: one line, at most HEALTH_OUTPUT_LIMIT characters, ending in … when cut. */
export function boundedOutput(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > HEALTH_OUTPUT_LIMIT
    ? `${line.slice(0, HEALTH_OUTPUT_LIMIT - 1)}…`
    : line;
}
/** When the next check of a Service is due; undefined before its checks may begin. */
export function nextCheckAt(
  state: HealthState,
  policy: HealthPolicy,
): number | undefined {
  if (state.eligibleSince === undefined) return undefined;
  return (
    Math.max(state.eligibleSince, state.checkedAt ?? 0) + policy.intervalMs
  );
}
/** A change a check result makes that Activity records. */
export type HealthEvent = "unhealthy" | "recovered";
/** One check result applied: a pass ends an unhealthy stretch and clears the count; a failure counts, and the one that
 * reaches `failures` marks the Service unhealthy. */
export function recordCheck(
  state: HealthState,
  result: { passed: boolean; output?: string },
  at: number,
  policy: HealthPolicy,
): { state: HealthState; event?: HealthEvent } {
  if (result.passed) {
    const { output: _output, episode, ...rest } = state;
    return {
      state: { ...rest, checkedAt: at, passed: true, failures: 0 },
      ...(episode ? { event: "recovered" as const } : {}),
    };
  }
  const failures = state.failures + 1;
  const marked = failures >= policy.failures && !state.episode;
  return {
    state: {
      ...state,
      checkedAt: at,
      passed: false,
      failures,
      ...(result.output !== undefined
        ? { output: boundedOutput(result.output) }
        : {}),
      ...(marked ? { episode: { since: at, restarts: [] } } : {}),
    },
    ...(marked ? { event: "unhealthy" as const } : {}),
  };
}
/** Whether the Service's failures have reached the policy's count, so Rig acts on it. */
export function isMarkedUnhealthy(
  state: HealthState,
  policy: Pick<HealthPolicy, "failures">,
): boolean {
  return state.passed === false && state.failures >= policy.failures;
}
/** What Rig does about an unhealthy Service now: nothing (it only reports, or is not marked), restart it, wait until the
 * back-off allows the next restart, or give up because it has been unhealthy for `retry_for`. */
export type HealthAction =
  | { kind: "none" }
  | { kind: "restart"; attempt: number }
  | { kind: "wait"; until: number }
  | { kind: "give-up" };
export function healthAction(
  state: HealthState,
  policy: HealthPolicy,
  now: number,
): HealthAction {
  const episode = state.episode;
  if (
    policy.onFailure !== "restart" ||
    !episode ||
    episode.gaveUp !== undefined ||
    !isMarkedUnhealthy(state, policy)
  )
    return { kind: "none" };
  if (
    policy.retryForMs !== undefined &&
    now - episode.since >= policy.retryForMs
  )
    return { kind: "give-up" };
  const last = episode.restarts.at(-1);
  const due =
    last === undefined
      ? episode.since
      : last +
        HEALTH_RESTART_BACKOFF_MS[
          Math.min(
            episode.restarts.length - 1,
            HEALTH_RESTART_BACKOFF_MS.length - 1,
          )
        ]!;
  return now >= due
    ? { kind: "restart", attempt: episode.restarts.length + 1 }
    : { kind: "wait", until: due };
}
/** The state after a health restart was attempted at `at`: the stretch goes on and counts the attempt, and the count starts
 * again. It still names the process that was judged, so a new one is recognized when it is seen, and one whose stop failed
 * is not mistaken for a new one. The last result stays, so the Service is still reported as marked. */
export function restarted(state: HealthState, at: number): HealthState {
  const episode = state.episode ?? { since: at, restarts: [] };
  const { eligibleSince: _next, ...rest } = state;
  return {
    ...rest,
    failures: 0,
    episode: { ...episode, restarts: [...episode.restarts, at] },
  };
}
/** Whether the Service is marked unhealthy: its failures reached the policy's count and no check has passed since, across
 * any health restart in between. */
export function isMarked(state: HealthState): boolean {
  return state.episode !== undefined;
}
/** The state after Rig gave up restarting at `at`: it keeps checking and reporting. */
export function gaveUp(state: HealthState, at: number): HealthState {
  return state.episode
    ? { ...state, episode: { ...state.episode, gaveUp: at } }
    : state;
}
