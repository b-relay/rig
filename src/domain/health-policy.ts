import type { ManagedComponent } from "../config/types";
import type { HealthCheck } from "../providers/contracts";
import { currentRun, type ServiceRun, type TargetRecord } from "./runtime";

/** Ongoing health checks (ADR 0012): the pure rules for what one check result means, and when an unhealthy Service with
 * `on_failure: restart` is restarted. Recorded times are wall-clock Unix milliseconds; whether a check or a restart is due
 * is decided on elapsed time, which the caller measures, so nothing here reads a clock and a correction of the clock
 * never moves a check or a restart. */

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
  /** Since when this process may be checked, in elapsed milliseconds: its start check passed and nothing is starting or
   * stopping its Target. */
  readonly eligibleSince?: number;
  /** When it was last checked: wall-clock Unix milliseconds, as shown, and elapsed milliseconds, which its interval counts
   * from. */
  readonly checkedAt?: number;
  readonly checkedMark?: number;
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
/** Whether the next check of a Service is due at `elapsed` (elapsed milliseconds): once it may be checked, at once for a
 * process not checked yet, then once `interval` has elapsed since the last check. */
export function checkDue(
  state: HealthState,
  policy: Pick<HealthPolicy, "intervalMs">,
  elapsed: number,
): boolean {
  return (
    state.eligibleSince !== undefined &&
    (state.checkedMark === undefined ||
      elapsed - state.checkedMark >= policy.intervalMs)
  );
}
/** A change a check result makes that Activity records. */
export type HealthEvent = "unhealthy" | "recovered";
/** One check result applied: a pass ends an unhealthy stretch and clears the count; a failure counts, and the one that
 * reaches `retries` makes the Service unhealthy. */
export function recordCheck(
  state: HealthState,
  result: { passed: boolean; output?: string },
  /** When it was checked: wall-clock and elapsed milliseconds. */
  at: { wall: number; elapsed: number },
  policy: Pick<HealthPolicy, "retries">,
): { state: HealthState; event?: HealthEvent } {
  const checked = { checkedAt: at.wall, checkedMark: at.elapsed };
  if (result.passed) {
    const { output: _output, stretch, ...rest } = state;
    return {
      state: { ...rest, ...checked, passed: true, failures: 0 },
      ...(stretch ? { event: "recovered" as const } : {}),
    };
  }
  const failures = state.failures + 1;
  const marked = failures >= policy.retries && !state.stretch;
  return {
    state: {
      ...state,
      ...checked,
      passed: false,
      failures,
      ...(result.output !== undefined
        ? { output: boundedOutput(result.output) }
        : {}),
      ...(marked ? { stretch: { since: at.wall, restarts: [] } } : {}),
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
/** `sinceRestart` is the elapsed time since the stretch's latest health restart (`healthRestartWait`). */
export function healthAction(
  state: HealthState,
  policy: HealthPolicy,
  sinceRestart: number,
): HealthAction {
  const stretch = state.stretch;
  if (policy.onFailure !== "restart" || !stretch) return { kind: "none" };
  if (state.passed !== false || state.failures < policy.retries)
    return { kind: "none" };
  const wait = healthRestartWait(stretch, sinceRestart);
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
/** How much longer the next health restart of an unhealthy stretch waits, in milliseconds, `sinceRestart` of elapsed time
 * after its latest health restart (any value before the first); zero or less once it is due. */
export function healthRestartWait(
  stretch: HealthStretch,
  sinceRestart: number,
): number {
  return stretch.restarts.length === 0
    ? 0
    : healthRestartBackoff(stretch) - sinceRestart;
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

/** The Service's ongoing check policy, from its recorded plan; undefined for a Service without a healthcheck, including
 * every plan recorded before healthcheck, whose `health` only gates start. */
export function healthPolicy(
  component: ManagedComponent,
): HealthPolicy | undefined {
  const check = component.healthcheck;
  if (!check) return undefined;
  return {
    intervalMs: check.interval * 1000,
    timeoutMs: check.timeout * 1000,
    retries: check.retries,
    onFailure: check.onFailure,
  };
}

/** Whether the Service's record says its last health restart's start failed, so the health monitor starts it again on the
 * back-off. Not once a Host restart stopped it: that keeps a working Target or Preview stopped until rig up, and a stable
 * Target is started by rigd's own start after the restart. */
export function healthStartPending(
  run: ServiceRun | undefined,
): run is ServiceRun & {
  healthStretch: NonNullable<ServiceRun["healthStretch"]>;
} {
  return (
    run?.healthStretch?.pendingStart !== undefined &&
    run.intent === "running" &&
    !(run.outcome?.kind === "unknown" && run.outcome.hostRestart)
  );
}
/** Which check a plan entry runs: its test, its policy, and what a test runs in or connects to. Results, and a restart, are
 * about one such check of one process; a deploy or edit that changes it starts afresh. */
export function checkIdentity(component: ManagedComponent): string {
  return JSON.stringify([
    component.health ?? null,
    component.healthcheck ?? null,
    component.workingDir ?? null,
    component.ports ?? component.port ?? null,
  ]);
}

/** `healthAction`, except that a process nothing identifies (adopted from a rigd older than incarnations) is never
 * restarted for its checks, since a restart could stop another process started meanwhile: it is checked and reported as
 * with report. */
export function identifiedHealthAction(
  state: HealthState,
  policy: HealthPolicy,
  sinceRestart: number,
): HealthAction {
  const action = healthAction(state, policy, sinceRestart);
  return action.kind === "restart" && state.incarnation === undefined
    ? { kind: "none" }
    : action;
}

/** What one probe answer means as a check result; no answer within `timeoutMs` failed. */
export function checkResult(
  answer: HealthCheck | undefined,
  timeoutMs: number,
): { passed: boolean; output?: string } {
  return answer === undefined
    ? {
        passed: false,
        output: `The check did not answer within ${timeoutMs / 1000}s.`,
      }
    : "ready" in answer && answer.ready
      ? { passed: true }
      : {
          passed: false,
          output: "reason" in answer ? answer.reason : "failed",
        };
}

/** The state a process of the Service starts from: nothing known of it, with the unhealthy stretch its record says a
 * health or automatic restart continued. The last output was about another process, and is not kept. */
export function seededHealth(
  target: Pick<TargetRecord, "services" | "plan">,
  service: string,
): HealthState {
  const record = currentRun(target, service)?.healthStretch;
  return record
    ? {
        ...NEW_HEALTH,
        stretch: { since: record.since, restarts: [...record.restarts] },
      }
    : NEW_HEALTH;
}

/** What is known of a Service after a read of its record: `known`, unless the read names another process or another check,
 * which start afresh from their record; and the unhealthy stretch as the record carries it on, when a health restart
 * counted an attempt there that `known` could not (its restart was itself a transition). */
export function judgedHealth(
  target: Pick<TargetRecord, "services" | "plan">,
  component: ManagedComponent,
  known: HealthState | undefined,
): HealthState {
  const run = currentRun(target, component.name);
  if (
    known === undefined ||
    (known.incarnation !== undefined &&
      run?.incarnation !== undefined &&
      run.incarnation !== known.incarnation) ||
    (known.check !== undefined && known.check !== checkIdentity(component))
  )
    return seededHealth(target, component.name);
  const record = run?.healthStretch;
  if (!record || run?.incarnation !== known.incarnation) return known;
  // The record counted an attempt the cache could not; or it says this process's health start failed although it was seen
  // running, a stretch its checks must end before anything forgets it.
  const longer =
    known.stretch &&
    record.since === known.stretch.since &&
    record.restarts.length > known.stretch.restarts.length;
  const unseen = !known.stretch && record.pendingStart !== undefined;
  return longer || unseen
    ? {
        ...known,
        stretch: { since: record.since, restarts: [...record.restarts] },
      }
    : known;
}
