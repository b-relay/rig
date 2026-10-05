import type { ManagedComponent, RestartPolicy } from "../config/types";
import { DEFAULT_RESTART_POLICY } from "../config/plan-defaults";
import { recordActivity } from "../domain/activity";
import { hostRestartText, type HostRestart } from "../domain/host-session";
import {
  RigError,
  diagnosticErrorCode,
  recoveredByDownFirst,
} from "../domain/errors";
import type {
  OperationRecord,
  RuntimeState,
  ServiceOutcome,
  ServiceRun,
  TargetRecord,
} from "../domain/runtime";
import type { ComponentReport } from "../domain/project-status";
import { targetSelector } from "../domain/target-selector";
import type { ProcessObservation } from "../providers/contracts";
import { boundedObservations } from "./bounded-observations";
import type { RuntimeDependencies } from "./contracts";
import type { ActivationJournal } from "./lifecycle";

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
 * until `rig up` (#283): while a Service of the Target still carries the outcome the restart left (see
 * `recordStoppedByHostRestart`), no unknown exit of the Target is retried, whatever its policy. The next explicit start
 * replaces those outcomes, and from then on unknown exits are retried as before. */
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

interface BudgetRule {
  readonly limit: number;
  readonly windowMs: number;
  /** "60 s", "10 min": the window as Activity and status name it. */
  readonly window: string;
  /** The delay before the next attempt when `spent` attempts are already in the window. */
  delayMs(spent: number): number;
}
const BUDGETS: Record<RestartBudget, BudgetRule> = {
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

type Deps = Pick<
  RuntimeDependencies,
  | "store"
  | "now"
  | "id"
  | "lifecycle"
  | "observations"
  | "observationBudgetMs"
  | "observationDeadline"
  | "diagnostic"
>;
type Activity = Pick<OperationRecord, "action" | "outcome" | "message">;

/** The record of `service` for the Deployment the Target now runs; a record left by another Deployment describes nothing. */
export function currentRun(
  target: Pick<TargetRecord, "services" | "plan">,
  service: string,
): ServiceRun | undefined {
  const run = target.services?.[service];
  return run?.deployment === target.plan.workspacePath ? run : undefined;
}

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
function spentAttempts(run: ServiceRun, budget: RestartBudget): number[] {
  return budget === "known-exit" ? run.attempts : (run.unknownAttempts ?? []);
}
/** `run` with `budget`'s spent attempts replaced by `attempts`. */
function withAttempts(
  run: ServiceRun,
  budget: RestartBudget,
  attempts: number[],
): ServiceRun {
  return budget === "known-exit"
    ? { ...run, attempts }
    : { ...run, unknownAttempts: attempts };
}

/** When the next automatic attempt from `budget` is due for a Service that ended at `endedAt`, keeping only the attempts
 * still inside the budget's window at `now`; `exhausted` when the window already holds the budget's limit. */
export function scheduleAttempt(
  run: ServiceRun,
  budget: RestartBudget,
  endedAt: number,
  now: number,
): { exhausted: true } | { run: ServiceRun } {
  const rule = BUDGETS[budget];
  const recent = spentAttempts(run, budget).filter(
    (at) => now - at < rule.windowMs,
  );
  if (recent.length >= rule.limit) return { exhausted: true };
  return {
    run: {
      ...withAttempts(run, budget, recent),
      retryAt: endedAt + rule.delayMs(recent.length),
    },
  };
}

/** Saves one Service's record with an optional Activity entry, in one write that touches nothing else of the saved Target:
 * restart evidence never rewrites a plan, a preparation or a pending transition.
 * `target` is updated in place and put back when the store refuses, so memory never claims more than disk. */
async function saveRun(
  target: TargetRecord,
  service: string,
  run: ServiceRun,
  deps: Pick<Deps, "store" | "now" | "id">,
  activity?: Activity,
): Promise<void> {
  await saveRuns(
    target,
    { [service]: run },
    deps,
    activity &&
      ((state) =>
        recordActivity(state, {
          id: deps.id(),
          projectId: target.projectId,
          project: state.projects.find((p) => p.id === target.projectId)?.name,
          target: target.name,
          occurredAt: deps.now(),
          ...activity,
        })),
  );
}

/** Saves the records of `runs` (by Service name) and whatever `alongside` records in one write, so all of it is saved or
 * none is; of the saved Target only those Services' records change. Rejects TARGET_UNKNOWN when the Target is no longer
 * recorded. `target` is updated in place and put back when the store refuses, so memory never claims more than disk. */
async function saveRuns(
  target: TargetRecord,
  runs: Readonly<Record<string, ServiceRun>>,
  deps: Pick<Deps, "store">,
  alongside?: (state: RuntimeState) => void,
): Promise<void> {
  const before = target.services;
  target.services = { ...before, ...runs };
  try {
    await deps.store.update((state) => {
      const saved = state.targets.find((t) => t.id === target.id);
      if (!saved)
        throw new RigError(
          "TARGET_UNKNOWN",
          `${target.name} is no longer recorded, so nothing about its Services can be.`,
          "Run rig status to see the recorded Targets.",
        );
      saved.services = { ...saved.services, ...runs };
      alongside?.(state);
    });
  } catch (error) {
    if (before) target.services = before;
    else delete target.services;
    throw error;
  }
}

/** The journal a start runs under. Every `starting` is saved before it answers, so a process never carries an incarnation the
 * record does not name. An `explicit` start (an operator's up or restart, a deployment, rigd's start of a Stable Target
 * after a Host restart) begins a new activation with full budgets of automatic attempts; an automatic one spends an
 * attempt of the named budget of the current activation. A `health` restart spends from neither budget and carries both
 * on, with `healthStretch`, the unhealthy stretch it continues. `afterHostRestart` marks each process an explicit start
 * makes as started after that restart, which status reports.
 * `failed` marks the Services an explicit start began as not started after it was rolled back; nothing retries that. */
export function activationJournal(
  target: TargetRecord,
  mode: "explicit" | RestartBudget | "health",
  deps: Pick<Deps, "store" | "now" | "id">,
  options: {
    afterHostRestart?: HostRestart;
    healthStretch?: NonNullable<ServiceRun["healthStretch"]>;
  } = {},
): ActivationJournal & { failed(error: unknown): Promise<void> } {
  const begun: string[] = [];
  return {
    async starting(service) {
      const incarnation = deps.id();
      const current = currentRun(target, service);
      const fresh: ServiceRun = {
        deployment: target.plan.workspacePath,
        intent: "running",
        incarnation,
        attempts: [],
        ...(mode === "explicit" && options.afterHostRestart
          ? { startedAfterHostRestart: options.afterHostRestart }
          : {}),
      };
      await saveRun(
        target,
        service,
        mode === "explicit"
          ? fresh
          : mode === "health"
            ? {
                ...carriedOver(fresh, current),
                ...(options.healthStretch
                  ? { healthStretch: options.healthStretch }
                  : {}),
              }
            : automaticStart(fresh, current, mode, Date.parse(deps.now())),
        deps,
      );
      begun.push(service);
      return incarnation;
    },
    // The lifecycle has verified readiness and listeners by now; nothing more is recorded for the transition.
    async activated() {},
    async failed(error) {
      for (const service of begun.splice(0)) {
        const run = currentRun(target, service);
        if (run)
          await saveRun(
            target,
            service,
            {
              ...run,
              outcome: {
                kind: "start-failed",
                errorCode: diagnosticErrorCode(error),
                at: deps.now(),
              },
            },
            deps,
          );
      }
    },
  };
}
/** `fresh` with what a start that is not explicit carries over from `current`: both budgets' spent attempts, and the
 * unhealthy stretch a health restart began. */
function carriedOver(
  fresh: ServiceRun,
  current: ServiceRun | undefined,
): ServiceRun {
  return {
    ...fresh,
    attempts: current?.attempts ?? [],
    ...(current?.unknownAttempts
      ? { unknownAttempts: current.unknownAttempts }
      : {}),
    ...(current?.healthStretch ? { healthStretch: current.healthStretch } : {}),
  };
}
/** The record of an automatic start at `now`: both budgets carry over from `current`, and `budget` spends one attempt. */
function automaticStart(
  fresh: ServiceRun,
  current: ServiceRun | undefined,
  budget: RestartBudget,
  now: number,
): ServiceRun {
  const carried: ServiceRun = {
    ...carriedOver(fresh, current),
    ...(budget === "unknown-exit" ? { restartedAfterUnknown: true } : {}),
  };
  return withAttempts(carried, budget, [
    ...spentAttempts(carried, budget),
    now,
  ]);
}

/** Records that an operator stopped the Target: no exit of any of its Services is retried and no retry stays scheduled.
 * Updates `target` in place; the caller saves it before it stops anything. */
export function intendStopped(target: TargetRecord): void {
  for (const [service, run] of Object.entries(target.services ?? {})) {
    const { retryAt: _retryAt, waitingFor: _waitingFor, ...rest } = run;
    target.services![service] = { ...rest, intent: "stopped" };
  }
}

/** Records that an operator's up succeeded: a Service it found already running (one an earlier down could not stop, say)
 * is meant to run again too. Updates `target` in place; the caller saves it. */
export function intendRunning(target: TargetRecord): void {
  for (const [service, run] of Object.entries(target.services ?? {})) {
    if (run.intent === "stopped")
      target.services![service] = { ...run, intent: "running" };
    // A Service the up found running (it survived a Host restart after all) is no longer stopped by that restart.
    const { outcome, ...rest } = target.services![service]!;
    if (outcome?.kind === "unknown" && outcome.hostRestart)
      target.services![service] = rest;
  }
}

/** Records, right after rigd detected `restart`, that each Service of `target` (a Working copy or Preview meant to run) not
 * seen running was stopped by it, so neither its policy nor an unknown-exit retry starts it again before an explicit start
 * (see `supervisionScope`). Only an outcome that would still be acted on is replaced: none yet, an unknown exit, or an
 * exit whose retry is pending; an earlier clean exit, failure or failed start that already keeps the Service stopped
 * stays as it was. No retry stays scheduled. A Service seen running survived and is left alone; one whose observation does
 * not answer within the status budget is counted as stopped, since a restart ends every process. A Service an operator
 * stopped, or whose automatic attempts are used up, keeps its record. Writes no Activity: the restart's own entry says why.
 * The records, and whatever `alongside` records, are saved in one write. Returns whether they were saved; a failure goes
 * to the diagnostic log. */
export async function recordStoppedByHostRestart(
  target: TargetRecord,
  restart: HostRestart,
  deps: Deps,
  alongside?: (state: RuntimeState) => void,
): Promise<boolean> {
  return await settleStopped(
    target,
    deps,
    (component, run) => {
      if (run?.intent === "stopped" || run?.exhausted) return undefined;
      const outcome = run?.outcome;
      // A Service waiting for its next health restart would be started by the health monitor whatever its restart
      // policy, so it is marked stopped by the Host restart too: only rig up starts it again.
      if (
        outcome &&
        outcome.kind !== "unknown" &&
        run?.healthStretch?.failedStart === undefined &&
        restartBudget(component.restart ?? DEFAULT_RESTART_POLICY, outcome) ===
          undefined
      )
        return undefined;
      return { kind: "unknown", hostRestart: restart, at: deps.now() };
    },
    alongside,
  );
}

/** Records, after an explicit start of `target` failed, that each Service not seen running was not started, unless the
 * start's journal already said so (with the same error) or an operator stopped it: nothing retries it automatically before
 * the next explicit start, and status reports it failed. An earlier start's failure is replaced, so status names what the
 * Target needs now. `alongside` is recorded in the same write, so the failure and whatever the caller records with it
 * are saved together or not at all. Returns whether they were saved. */
export async function recordFailedStart(
  target: TargetRecord,
  error: unknown,
  deps: Deps,
  alongside?: (state: RuntimeState) => void,
): Promise<boolean> {
  const errorCode = diagnosticErrorCode(error);
  return await settleStopped(
    target,
    deps,
    (_component, run) =>
      run?.intent === "stopped" ||
      (run?.outcome?.kind === "start-failed" &&
        run.outcome.errorCode === errorCode)
        ? undefined
        : { kind: "start-failed", errorCode, at: deps.now() },
    alongside,
  );
}

/** Gives each managed Service of `target` not seen running the outcome `decide` returns for it, clearing any scheduled
 * retry; `decide` returning nothing leaves the record alone. A Service whose observation does not answer within the status
 * budget counts as not running. The outcomes and whatever `alongside` records are saved in one write, so all of it is
 * saved or none is. Returns whether it was saved; a failure goes to the diagnostic log. */
async function settleStopped(
  target: TargetRecord,
  deps: Deps,
  decide: (
    component: ManagedComponent,
    run: ServiceRun | undefined,
  ) => ServiceOutcome | undefined,
  alongside?: (state: RuntimeState) => void,
): Promise<boolean> {
  const runs: Record<string, ServiceRun> = {};
  try {
    for (const component of target.plan.components) {
      if (component.kind !== "managed") continue;
      const service = component.name;
      const [observed] = await boundedObservations(
        [(signal) => deps.observations.process(target, component, signal)],
        deps.observationBudgetMs,
        deps.observationDeadline,
      );
      if (observed?.kind === "completed" && observed.value.state === "running")
        continue;
      const run = currentRun(target, service);
      const outcome = decide(component, run);
      if (!outcome) continue;
      const {
        retryAt: _retryAt,
        waitingFor: _waitingFor,
        ...rest
      }: ServiceRun = run ?? {
        deployment: target.plan.workspacePath,
        intent: "running",
        attempts: [],
      };
      runs[service] = { ...rest, outcome };
    }
    if (Object.keys(runs).length || alongside)
      await saveRuns(target, runs, deps, alongside);
    return true;
  } catch (error) {
    await deps
      .diagnostic({
        operationId: deps.id(),
        action: "reconcile",
        outcome: "failed",
        target: target.name,
        errorCode: diagnosticErrorCode(error),
      })
      .catch(() => {});
    return false;
  }
}

/** One pass over a Target meant to run. A running Service is left alone, which is how a process that survived the daemon is
 * adopted. A stopped one has its outcome recorded once, then is started again only when its policy (within `scope`) retries
 * that outcome, the outcome's budget allows and its backoff has passed. A due attempt waits, spending nothing, while a
 * Service it depends on is not running, and after an unknown exit while one of its ports still accepts connections.
 * Returns when the earliest scheduled attempt is due, in Unix milliseconds.
 * A record that cannot be saved ends the Service's pass before anything is started. */
export async function superviseTarget(
  target: TargetRecord,
  deps: Deps,
  scope: SupervisionScope = DEFAULT_SUPERVISION_SCOPE,
): Promise<number | undefined> {
  let next: number | undefined;
  for (const component of target.plan.components) {
    if (component.kind !== "managed") continue;
    try {
      const due = await superviseService(target, component, deps, scope);
      if (due !== undefined) next = Math.min(next ?? due, due);
    } catch (error) {
      await deps
        .diagnostic({
          operationId: deps.id(),
          action: "supervise",
          outcome: "failed",
          target: target.name,
          errorCode: diagnosticErrorCode(error),
        })
        .catch(() => {});
    }
  }
  return next;
}

async function superviseService(
  target: TargetRecord,
  component: ManagedComponent,
  deps: Deps,
  scope: SupervisionScope,
): Promise<number | undefined> {
  const service = component.name;
  // An observation that does not answer within the status budget decides nothing; the pass moves on. A stopped one means
  // nothing of the start runs any more, the application a capture wrapper last reported included.
  const [observed] = await boundedObservations(
    [(signal) => deps.observations.process(target, component, signal)],
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  if (observed?.kind === "rejected") throw observed.error;
  if (observed?.kind === "completed" && observed.value.state === "running")
    await clearHostRestartOutcome(target, service, deps);
  if (observed?.kind !== "completed" || observed.value.state !== "stopped")
    return undefined;
  const observation = observed.value;
  let run = currentRun(target, service);
  if (run?.intent === "stopped" || run?.exhausted) return undefined;
  // A health restart whose start failed is the health monitor's to try again, on its back-off: neither restart: nor the
  // automatic-restart budget decides it. Without a healthcheck that restarts any more, restart policy takes it back.
  if (
    run?.healthStretch?.failedStart !== undefined &&
    !(run.outcome?.kind === "unknown" && run.outcome.hostRestart) &&
    component.healthcheck?.onFailure === "restart"
  )
    return undefined;
  const policy = component.restart ?? DEFAULT_RESTART_POLICY;
  if (!run?.outcome) {
    const outcome = observedOutcome(run, observation, deps.now());
    run = {
      ...(run ?? {
        deployment: target.plan.workspacePath,
        intent: "running",
        attempts: [],
      }),
      outcome,
    };
    await saveRun(
      target,
      service,
      run,
      deps,
      exitActivity(service, outcome, restartBudget(policy, outcome, scope)),
    );
  }
  const outcome = run.outcome!;
  const budget = restartBudget(policy, outcome, scope);
  if (!budget) return undefined;
  const now = Date.parse(deps.now());
  if (run.retryAt === undefined) {
    const scheduled = scheduleAttempt(run, budget, Date.parse(outcome.at), now);
    if ("exhausted" in scheduled) {
      await saveRun(target, service, { ...run, exhausted: true }, deps, {
        action: "restart",
        outcome: "failed",
        message: `${service} ${exhaustedText(budget)} and stays stopped. Run rig restart ${targetSelector(target)} once the cause is fixed.`,
      });
      return undefined;
    }
    run = scheduled.run;
    await saveRun(target, service, run, deps);
  }
  if (now < run.retryAt!) return run.retryAt;
  if (budget === "unknown-exit") {
    // Nothing says the process that ended is not still serving under another identity: its ports must be free first.
    const busy = await listeningPorts(target, component, deps);
    if (busy === undefined) return undefined;
    if (busy.length) {
      await holdBack(target, service, run, { ports: busy }, deps);
      return undefined;
    }
  }
  const journal = activationJournal(target, budget, deps);
  let started: Awaited<ReturnType<Deps["lifecycle"]["recover"]>>;
  try {
    started = await deps.lifecycle.recover(target, service, journal);
  } catch (error) {
    const current = currentRun(target, service)!;
    const refusedBeforeStart = current.incarnation === run.incarnation;
    // A refusal for a dependency that is down spawned nothing: the Service waits for it without spending budget.
    const dependency = refusedBeforeStart
      ? missingDependency(error)
      : undefined;
    if (dependency !== undefined) {
      await holdBack(target, service, current, { service: dependency }, deps);
      return undefined;
    }
    // Every other failed attempt spends budget, one refused before anything was spawned too, so a Service that cannot
    // start ends exhausted and visible instead of being asked again forever.
    const { retryAt: _retryAt, waitingFor: _waitingFor, ...rest } = current;
    await saveRun(
      target,
      service,
      {
        ...(refusedBeforeStart
          ? withAttempts(rest, budget, [...spentAttempts(rest, budget), now])
          : rest),
        outcome: failedAttemptOutcome(error, deps.now()),
      },
      deps,
      {
        action: "restart",
        outcome: "failed",
        message: `${service} could not be started again automatically (${diagnosticErrorCode(error)}).`,
      },
    );
    return await superviseService(target, component, deps, scope);
  }
  if (started.outcome === "unchanged") {
    // It was found running, started by something else: nothing was spent, and nothing of the ended process stays scheduled.
    const {
      retryAt: _retryAt,
      waitingFor: _waitingFor,
      outcome: _outcome,
      ...rest
    } = currentRun(target, service)!;
    await saveRun(target, service, rest, deps);
    return undefined;
  }
  const attempts = spentAttempts(currentRun(target, service)!, budget).length;
  await deps.store.update((state) =>
    recordActivity(state, {
      id: deps.id(),
      projectId: target.projectId,
      project: state.projects.find((p) => p.id === target.projectId)?.name,
      target: target.name,
      occurredAt: deps.now(),
      action: "restart",
      outcome: "started",
      message: startedText(service, budget, attempts),
    }),
  );
  return undefined;
}

/** Drops the outcome a Host restart left on a Service seen running after all (its observation had not answered when the
 * restart was recorded), so its later exit is recorded and judged like any other. */
async function clearHostRestartOutcome(
  target: TargetRecord,
  service: string,
  deps: Deps,
): Promise<void> {
  const run = currentRun(target, service);
  if (run?.outcome?.kind !== "unknown" || !run.outcome.hostRestart) return;
  const { outcome: _outcome, ...rest } = run;
  await saveRun(target, service, rest, deps);
}

/** The Service's ports that still accept connections, or nothing when the probe did not answer within the status budget. */
async function listeningPorts(
  target: TargetRecord,
  component: ManagedComponent,
  deps: Deps,
): Promise<number[] | undefined> {
  const [probed] = await boundedObservations(
    [(signal) => deps.observations.listening(target, component, signal)],
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  if (probed?.kind === "rejected") throw probed.error;
  return probed?.kind === "completed" ? probed.value : undefined;
}

/** The Service a SERVICE_DEPENDENCY refusal names, or nothing for any other failure. */
function missingDependency(error: unknown): string | undefined {
  if (!(error instanceof RigError) || error.code !== "SERVICE_DEPENDENCY")
    return undefined;
  const { dependency } = error.details;
  return typeof dependency === "string" ? dependency : undefined;
}

/** Records why a due attempt waits, with Activity only when the reason changes, so a long wait is one entry. */
async function holdBack(
  target: TargetRecord,
  service: string,
  run: ServiceRun,
  waitingFor: NonNullable<ServiceRun["waitingFor"]>,
  deps: Deps,
): Promise<void> {
  if (JSON.stringify(run.waitingFor) === JSON.stringify(waitingFor)) return;
  await saveRun(target, service, { ...run, waitingFor }, deps, {
    action: "restart",
    outcome: "unchanged",
    message: `${service} is not started again yet: ${waitingText(waitingFor)}. Waiting spends none of its automatic restarts.`,
  });
}

/** Records on the Service's current run the unhealthy stretch a health restart is about to continue. */
export async function recordHealthStretch(
  target: TargetRecord,
  service: string,
  stretch: NonNullable<ServiceRun["healthStretch"]>,
  deps: Pick<Deps, "store" | "now" | "id">,
): Promise<void> {
  const current = currentRun(target, service);
  if (current)
    await saveRun(
      target,
      service,
      { ...current, healthStretch: stretch },
      deps,
    );
}
/** Records how a health restart's start failed. When nothing of it runs (`stopped`), the outcome, as a failed automatic
 * attempt's is recorded, and the unhealthy stretch with `failedStart`, so the health monitor, not automatic restart,
 * starts it again at the next step of its back-off; no scheduled retry is kept. When the replacement could not be
 * confirmed stopped (its rollback failed, or it could not be observed), it is the running process as far as Rig knows:
 * only the stretch is kept, without `failedStart`, so ongoing checks judge it and the back-off goes on. */
export async function recordFailedHealthStart(
  target: TargetRecord,
  service: string,
  error: unknown,
  stretch: NonNullable<ServiceRun["healthStretch"]>,
  stopped: boolean,
  deps: Pick<Deps, "store" | "now" | "id">,
): Promise<void> {
  const current = currentRun(target, service);
  if (!current) return;
  const { retryAt: _retryAt, waitingFor: _waitingFor, ...rest } = current;
  await saveRun(
    target,
    service,
    stopped
      ? {
          ...rest,
          outcome: failedAttemptOutcome(error, deps.now()),
          healthStretch: { ...stretch, failedStart: Date.parse(deps.now()) },
        }
      : { ...rest, healthStretch: stretch },
    deps,
  );
}
/** What a failed automatic attempt leaves on record. A start refused before it was journalled, or one Rig itself stopped, is a failure it witnessed. A process that
 * ended on its own before it was ready is judged like any other exit: by its evidence, and `unknown` without any. A rollback
 * that could not be verified may have left the process behind, and a start the supervisor failed may have ended unseen. */
function failedAttemptOutcome(error: unknown, at: string): ServiceOutcome {
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

/** What status says about a Service whose process is stopped, from the record and the observation alone; it writes nothing,
 * so an exit no pass has recorded yet reads the same as it will once one has. */
export function stoppedStanding(
  target: Pick<
    TargetRecord,
    "services" | "plan" | "desired" | "kind" | "name" | "branch"
  >,
  component: ManagedComponent,
  observation: ProcessObservation,
  scope: SupervisionScope = DEFAULT_SUPERVISION_SCOPE,
): Pick<ComponentReport, "state" | "exit" | "exitCode" | "signal" | "reason"> {
  const run = currentRun(target, component.name);
  if (target.desired !== "running" || run?.intent === "stopped")
    return {
      state: "stopped",
      ...(run ? { exit: "requested" } : {}),
      // Still a requested stop, but one the operator should hear needed SIGKILL: the grace may be too short.
      ...(run?.stopKilled
        ? {
            signal: "SIGKILL",
            reason:
              run.stopKilled === "timeout"
                ? "Stopped after timeout (SIGKILL): it did not exit within its stop_timeout."
                : "Killed by --kill (SIGKILL) before its stop_timeout ended.",
          }
        : {}),
    };
  const outcome = run?.outcome ?? observedOutcome(run, observation, "");
  const selector = targetSelector(target);
  const again = `Run rig up ${selector} to start it again.`;
  if (outcome.kind === "unknown" && outcome.hostRestart)
    return {
      state: "stopped",
      exit: "unknown",
      reason: `It stopped when ${hostRestartText(outcome.hostRestart)}. Only stable Targets are started again after that; the working Target and Previews stay stopped. ${again}`,
    };
  const policy = component.restart ?? DEFAULT_RESTART_POLICY;
  const budget = restartBudget(policy, outcome, scope);
  const pending = budget !== undefined && !run?.exhausted;
  const next = run?.waitingFor
    ? waitingText(run.waitingFor)
    : "an automatic restart is scheduled";
  if (outcome.kind === "unknown") {
    const ended =
      "The process is not running and nothing recorded how it ended";
    return {
      state: pending ? "starting" : "failed",
      exit: "unknown",
      reason: pending
        ? `${ended}; under restart: always it is started again once it is verified gone and its ports are free (${next}).`
        : run?.exhausted
          ? `${ended}, and it ${exhaustedText("unknown-exit")}, so it stays stopped. ${again}`
          : `${ended}, so it was not restarted. ${again}`,
    };
  }
  const ended =
    outcome.kind === "exited"
      ? `The process ${describeExit(outcome)}`
      : `The last start failed (${outcome.errorCode})`;
  return {
    state: pending ? "starting" : cleanExit(outcome) ? "stopped" : "failed",
    exit: cleanExit(outcome) ? "clean" : "failed",
    ...(outcome.kind === "exited" && outcome.exitCode !== undefined
      ? { exitCode: outcome.exitCode }
      : {}),
    ...(outcome.kind === "exited" && outcome.signal !== undefined
      ? { signal: outcome.signal }
      : {}),
    reason: pending
      ? `${ended}; ${next}.`
      : run?.exhausted
        ? `${ended} after ${RESTART_LIMIT} automatic restarts within ${BUDGETS["known-exit"].window}, so it stays stopped. ${again}`
        : outcome.kind === "start-failed"
          ? `${ended}. ${recoveredByDownFirst(outcome.errorCode) ? `Run rig down ${selector}, then rig up ${selector} to start it again.` : again}`
          : `${ended} and its restart policy is ${policy}, so it stays stopped. ${again}`,
  };
}

/** What status adds about a running Service: that it was started again automatically after an unknown exit, or by rigd
 * after a Host restart, while the process running is the one that start made. */
export function runningNote(
  target: Pick<TargetRecord, "services" | "plan">,
  component: ManagedComponent,
  observation: ProcessObservation,
): string | undefined {
  const run = currentRun(target, component.name);
  if (
    observation.incarnation === undefined ||
    observation.incarnation !== run?.incarnation
  )
    return undefined;
  if (run.restartedAfterUnknown)
    return "Started again automatically after its previous process ended with nothing recorded about how (unknown exit, restarted).";
  if (run.startedAfterHostRestart)
    return `Started again by rigd after ${hostRestartText(run.startedAfterHostRestart)} (${run.startedAfterHostRestart === "reboot" ? "restarted after reboot" : "restarted after login"}).`;
  return undefined;
}

function exitActivity(
  service: string,
  outcome: ServiceOutcome,
  budget: RestartBudget | undefined,
): Activity {
  if (outcome.kind !== "exited")
    return {
      action: "exit",
      outcome: "failed",
      message: budget
        ? `${service} is not running and nothing recorded how it ended; under restart: always it is started again once it is verified gone and its ports are free.`
        : `${service} is not running and nothing recorded how it ended, so it was not started again.`,
    };
  return {
    action: cleanExit(outcome) ? "exit" : "crash",
    outcome: cleanExit(outcome) ? "stopped" : "failed",
    message: `${service} ${describeExit(outcome)}.`,
  };
}

/** "used its 5 automatic restarts within 60 s", "ended with nothing recorded after its 3 automatic restarts within 10 min". */
function exhaustedText(budget: RestartBudget): string {
  const rule = BUDGETS[budget];
  return budget === "known-exit"
    ? `used its ${rule.limit} automatic restarts within ${rule.window}`
    : `ended with nothing recorded about how after its ${rule.limit} automatic restarts for unknown exits within ${rule.window}`;
}

function startedText(
  service: string,
  budget: RestartBudget,
  attempt: number,
): string {
  const rule = BUDGETS[budget];
  return budget === "known-exit"
    ? `${service} was started again automatically (attempt ${attempt} of ${rule.limit} within ${rule.window}).`
    : `${service} ended with nothing recorded about how and was started again automatically (unknown exit, restarted: attempt ${attempt} of ${rule.limit} within ${rule.window}).`;
}

function waitingText(
  waitingFor: NonNullable<ServiceRun["waitingFor"]>,
): string {
  if ("service" in waitingFor)
    return `waiting for ${waitingFor.service}, which it depends on, to be running`;
  const [first, ...rest] = waitingFor.ports;
  return rest.length
    ? `waiting for ports ${waitingFor.ports.join(", ")}, which still accept connections, to be free`
    : `waiting for port ${first}, which still accepts connections, to be free`;
}

/** Who recorded an end the application's own record does not describe. `launchd` appears only in outcomes recorded by Rig
 * versions that offered launchd supervision. */
const WITNESSES = {
  launchd: "from launchd's record of its job",
  rigd: "from rigd's record of its capture wrapper",
} as const;

/** "exited with code 3", "was ended by SIGKILL", "was ended by SIGTERM (from rigd's record of its capture wrapper)". */
export function describeExit(
  outcome: Extract<ServiceOutcome, { kind: "exited" }>,
): string {
  const ended =
    outcome.signal === undefined
      ? `exited with code ${outcome.exitCode}`
      : `was ended by ${outcome.signal}`;
  return outcome.recordedBy === undefined
    ? ended
    : `${ended} (${WITNESSES[outcome.recordedBy]})`;
}
