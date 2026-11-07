import type { ManagedComponent, RestartPolicy } from "../config/types";
import { DEFAULT_RESTART_POLICY } from "../config/plan-defaults";
import { RigError, diagnosticErrorCode } from "./errors";
import { healthStartPending } from "./health-policy";
import {
  currentRun,
  type ServiceOutcome,
  type ServiceRun,
  type TargetRecord,
} from "./runtime";
import type { ProcessObservation } from "../providers/contracts";

/** Automatic restart (ADR 0002): the pure rules for what an exit means and whether, when and from which budget a stopped
 * Service is started again. Times are Unix milliseconds; ages are elapsed milliseconds the caller measures. */

/** Automatic attempts after a known exit allowed within RESTART_WINDOW_MS of each other. */
export const RESTART_LIMIT = 5;
export const RESTART_WINDOW_MS = 60_000;
/** Delay before the first automatic attempt after a known exit; each further attempt in the window doubles it. */
export const RESTART_BACKOFF_MS = 100;
/** Automatic attempts after an unknown exit allowed within UNKNOWN_EXIT_RESTART_WINDOW_MS of each other. Nothing says why
 * such a process ended, so this budget is separate from the one above and much slower. */
export const UNKNOWN_EXIT_RESTART_LIMIT = 3;
export const UNKNOWN_EXIT_RESTART_WINDOW_MS = 10 * 60_000;
/** Delay before each automatic attempt after an unknown exit, by how many attempts the window already holds. */
export const UNKNOWN_EXIT_RESTART_BACKOFF_MS = [
  5_000, 60_000, 300_000,
] as const;

/** Which budget an automatic attempt draws on: the one for known exits, or the slower one for unknown exits. */
export type RestartBudget = "known-exit" | "unknown-exit";

/** What a supervision pass may do beyond each Service's own restart policy. With `retryUnknownExits` false no unknown exit
 * of the Target is started again, whatever its policy: a rule that knows more about why every process vanished (a detected
 * Host restart, say) narrows the pass per Target through this. */
export interface SupervisionScope {
  readonly retryUnknownExits: boolean;
}
export const DEFAULT_SUPERVISION_SCOPE: SupervisionScope = {
  retryUnknownExits: true,
};
/** The scope `target` is supervised and reported under. After a Host restart the Working copy and Previews stay stopped
 * until `rig up` (#283): while a Service of the Target still carries the outcome the restart left, no unknown exit of the
 * Target is retried, whatever its policy. The next explicit start replaces those outcomes. */
export function supervisionScope(
  target: Pick<TargetRecord, "services" | "plan">,
): SupervisionScope {
  const stoppedByRestart = target.plan.components.some((component) => {
    if (component.kind !== "managed") return false;
    const outcome = currentRun(target, component.name)?.outcome;
    return outcome?.kind === "unknown" && outcome.hostRestart !== undefined;
  });
  return stoppedByRestart
    ? { retryUnknownExits: false }
    : DEFAULT_SUPERVISION_SCOPE;
}

/** One budget's allowance. */
export interface BudgetRule {
  readonly limit: number;
  readonly windowMs: number;
  /** "60 s", "10 min": the window as Activity and status name it. */
  readonly window: string;
  /** The delay before the next attempt when `spent` attempts are already in the window. */
  delayMs(spent: number): number;
}
export const RESTART_BUDGETS: Readonly<Record<RestartBudget, BudgetRule>> = {
  "known-exit": {
    limit: RESTART_LIMIT,
    windowMs: RESTART_WINDOW_MS,
    window: `${RESTART_WINDOW_MS / 1000} s`,
    delayMs: (spent) => RESTART_BACKOFF_MS * 2 ** spent,
  },
  "unknown-exit": {
    limit: UNKNOWN_EXIT_RESTART_LIMIT,
    windowMs: UNKNOWN_EXIT_RESTART_WINDOW_MS,
    window: `${UNKNOWN_EXIT_RESTART_WINDOW_MS / 60_000} min`,
    delayMs: (spent) =>
      UNKNOWN_EXIT_RESTART_BACKOFF_MS[
        Math.min(spent, UNKNOWN_EXIT_RESTART_BACKOFF_MS.length - 1)
      ]!,
  },
};

/** What a stopped observation proves about the process Rig last started. Only evidence that names that process counts;
 * anything else is `unknown`, which is neither a clean exit, a failure nor a requested stop. */
export function observedOutcome(
  run: ServiceRun | undefined,
  observation: ProcessObservation,
  at: string,
): ServiceOutcome {
  const known =
    run?.incarnation !== undefined &&
    observation.incarnation === run.incarnation &&
    (observation.exitCode !== undefined || observation.signal !== undefined);
  if (!known) return { kind: "unknown", at };
  return {
    kind: "exited",
    ...(observation.exitCode === undefined
      ? {}
      : { exitCode: observation.exitCode }),
    ...(observation.signal === undefined ? {} : { signal: observation.signal }),
    ...(observation.recordedBy === undefined
      ? {}
      : { recordedBy: observation.recordedBy }),
    at,
  };
}

/** Whether an exit counts as a success: code 0 and no signal. */
export function cleanExit(outcome: ServiceOutcome): boolean {
  return (
    outcome.kind === "exited" &&
    outcome.exitCode === 0 &&
    outcome.signal === undefined
  );
}

/** The budget an automatic start after `outcome` draws on under `policy`, or nothing when the Service stays stopped.
 * A known exit follows the policy. An unknown exit is started again only under `always`, and only while `scope` allows it;
 * a failed explicit start never is. */
export function restartBudget(
  policy: RestartPolicy,
  outcome: ServiceOutcome,
  scope: SupervisionScope = DEFAULT_SUPERVISION_SCOPE,
): RestartBudget | undefined {
  if (outcome.kind === "start-failed") return undefined;
  if (outcome.kind === "unknown")
    return policy === "always" && scope.retryUnknownExits
      ? "unknown-exit"
      : undefined;
  if (policy === "no") return undefined;
  return policy === "always" || !cleanExit(outcome) ? "known-exit" : undefined;
}

/** The automatic attempts `run` has spent from `budget`'s allowance since the last explicit start. */
export function spentAttempts(
  run: ServiceRun,
  budget: RestartBudget,
): number[] {
  return budget === "known-exit" ? run.attempts : (run.unknownAttempts ?? []);
}
/** `run` with `budget`'s spent attempts replaced by `attempts`. */
export function withAttempts(
  run: ServiceRun,
  budget: RestartBudget,
  attempts: number[],
): ServiceRun {
  return budget === "known-exit"
    ? { ...run, attempts }
    : { ...run, unknownAttempts: attempts };
}

/** When the next automatic attempt from `budget` is due for a Service that ended at `endedAt`, keeping only the attempts
 * still inside the budget's window: those whose age (`ages`, elapsed milliseconds, one per spent attempt in order) is
 * under it. `exhausted` when the window already holds the budget's limit. `retryAt` is the wall-clock time the delay after
 * `endedAt` ends, as recorded and shown; the delay itself, `retryAt - endedAt`, is waited in elapsed time. */
export function scheduleAttempt(
  run: ServiceRun,
  budget: RestartBudget,
  endedAt: number,
  ages: readonly number[],
): { exhausted: true } | { run: ServiceRun } {
  const rule = RESTART_BUDGETS[budget];
  const recent = spentAttempts(run, budget).filter((_at, index) =>
    inWindow(budget, ages[index]!),
  );
  if (recent.length >= rule.limit) return { exhausted: true };
  return {
    run: {
      ...withAttempts(run, budget, recent),
      retryAt: endedAt + rule.delayMs(recent.length),
    },
  };
}

/** Whether an attempt `age` elapsed milliseconds old still counts against `budget`. */
export function inWindow(budget: RestartBudget, age: number): boolean {
  return age < RESTART_BUDGETS[budget].windowMs;
}

/** `run` with no retry scheduled and no wait recorded. */
export function withoutRetry(run: ServiceRun): ServiceRun {
  const { retryAt: _retryAt, waitingFor: _waitingFor, ...rest } = run;
  return rest;
}

/** Whether the health monitor, not restart policy, starts `component` again: a health restart whose start failed is its to
 * try again on its back-off (`healthStartPending`), while the Service still has a healthcheck that restarts. */
export function healthOwnsStart(
  component: Pick<ManagedComponent, "healthcheck">,
  run: ServiceRun | undefined,
): boolean {
  return (
    healthStartPending(run) && component.healthcheck?.onFailure === "restart"
  );
}

/** Whether a detected Host restart stopped a Service not seen running whose record is `run`. Only an outcome that would
 * still be acted on is replaced: none yet, an unknown exit, an exit whose retry is pending, or a health restart still to
 * come. An operator's stop, used-up attempts, and an outcome that already keeps it stopped stay as they are. */
export function stoppedByHostRestart(
  component: Pick<ManagedComponent, "restart">,
  run: ServiceRun | undefined,
): boolean {
  if (run?.intent === "stopped" || run?.exhausted) return false;
  const outcome = run?.outcome;
  return !(
    outcome &&
    outcome.kind !== "unknown" &&
    run?.healthStretch?.pendingStart === undefined &&
    restartBudget(component.restart ?? DEFAULT_RESTART_POLICY, outcome) ===
      undefined
  );
}

/** Whether a failed explicit start with `errorCode` gives a Service not seen running a new `start-failed` outcome: not when an
 * operator stopped it, nor when its record already says so with the same error. */
export function failedStartRecorded(
  run: ServiceRun | undefined,
  errorCode: string,
): boolean {
  return !(
    run?.intent === "stopped" ||
    (run?.outcome?.kind === "start-failed" &&
      run.outcome.errorCode === errorCode)
  );
}

/** Whether `run` keeps its Service stopped whatever a pass sees: an outcome already recorded, an operator's stop, used-up
 * attempts, or a health restart still to come. */
export function recordKeepsStopped(run: ServiceRun | undefined): boolean {
  return (
    run?.outcome !== undefined ||
    run?.exhausted === true ||
    run?.intent === "stopped" ||
    run?.healthStretch?.pendingStart !== undefined
  );
}

/** What a failed automatic attempt from `budget` made at `attemptAt` leaves on `current`, the record as the attempt left it.
 * `refusedBeforeStart` when nothing was journalled, so the start spawned nothing. A refusal for a dependency that is down
 * waits for it, spending nothing. Every other failure is recorded with its outcome; one refused before anything was spawned
 * spends its attempt here (a start that spawned spent it in its journal), so a Service that cannot start ends exhausted. */
export function failedAttempt(
  current: ServiceRun,
  refusedBeforeStart: boolean,
  budget: RestartBudget,
  attemptAt: number,
  error: unknown,
  at: string,
): { waitingFor: { service: string } } | { run: ServiceRun } {
  const dependency = refusedBeforeStart ? missingDependency(error) : undefined;
  if (dependency !== undefined) return { waitingFor: { service: dependency } };
  const rest = withoutRetry(current);
  return {
    run: {
      ...(refusedBeforeStart
        ? withAttempts(rest, budget, [
            ...spentAttempts(rest, budget),
            attemptAt,
          ])
        : rest),
      outcome: failedAttemptOutcome(error, at),
    },
  };
}

/** The Service a SERVICE_DEPENDENCY refusal names, or nothing for any other failure. */
function missingDependency(error: unknown): string | undefined {
  if (!(error instanceof RigError) || error.code !== "SERVICE_DEPENDENCY")
    return undefined;
  const { dependency } = error.details;
  return typeof dependency === "string" ? dependency : undefined;
}

/** What a failed automatic attempt leaves on record. A start refused before it was journalled, or one Rig itself stopped,
 * is a failure it witnessed. A process that ended on its own before it was ready is judged like any other exit: by its
 * evidence, and `unknown` without any. A rollback that could not be verified may have left the process behind, and a start
 * the supervisor failed may have ended unseen. */
export function failedAttemptOutcome(
  error: unknown,
  at: string,
): ServiceOutcome {
  const code = diagnosticErrorCode(error);
  if (code === "START_ROLLBACK_FAILED" || code === "START_UNVERIFIED")
    return { kind: "unknown", at };
  if (code !== "PROCESS_EXITED")
    return { kind: "activation-failed", errorCode: code, at };
  const { exitCode, signal } = (error as RigError).details;
  return typeof exitCode === "number" || typeof signal === "string"
    ? {
        kind: "exited",
        ...(typeof exitCode === "number" ? { exitCode } : {}),
        ...(typeof signal === "string" ? { signal } : {}),
        at,
      }
    : { kind: "unknown", at };
}
