import type { ManagedComponent, RestartPolicy } from "../config/types";
import { recordActivity } from "../domain/activity";
import { RigError, diagnosticErrorCode } from "../domain/errors";
import type {
  OperationRecord,
  ServiceOutcome,
  ServiceRun,
  TargetRecord,
} from "../domain/runtime";
import type { ComponentReport } from "../domain/project-status";
import type { ProcessObservation } from "../providers/contracts";
import { boundedObservations } from "./bounded-observations";
import type { RuntimeDependencies } from "./contracts";
import type { ActivationJournal } from "./lifecycle";

/** Automatic attempts allowed within RESTART_WINDOW_MS of each other. */
export const RESTART_LIMIT = 5;
export const RESTART_WINDOW_MS = 60_000;
/** Delay before the first automatic attempt; each further attempt in the window doubles it. */
export const RESTART_BACKOFF_MS = 100;

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

/** Whether `policy` starts the Service again after `outcome`. An unknown outcome and a failed explicit start never do. */
export function retries(
  policy: RestartPolicy,
  outcome: ServiceOutcome,
): boolean {
  if (outcome.kind === "unknown" || outcome.kind === "start-failed")
    return false;
  if (policy === "no") return false;
  return policy === "always" || !cleanExit(outcome);
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
  const before = target.services;
  target.services = { ...before, [service]: run };
  try {
    await deps.store.update((state) => {
      const saved = state.targets.find((t) => t.id === target.id);
      if (!saved)
        throw new RigError(
          "TARGET_UNKNOWN",
          `${target.name} is no longer recorded, so nothing about its Services can be.`,
          "Run rig status to see the recorded Targets.",
        );
      saved.services = { ...saved.services, [service]: run };
      if (activity)
        recordActivity(state, {
          id: deps.id(),
          projectId: target.projectId,
          project: state.projects.find((p) => p.id === target.projectId)?.name,
          target: target.name,
          occurredAt: deps.now(),
          ...activity,
        });
    });
  } catch (error) {
    if (before) target.services = before;
    else delete target.services;
    throw error;
  }
}

/** The journal a start runs under. Every `starting` is saved before it answers, so a process never carries an incarnation the
 * record does not name. An `explicit` start (an operator's up or restart, a deployment) begins a new activation with a full
 * budget of automatic attempts; an `automatic` one spends an attempt of the current activation.
 * `failed` marks the Services an explicit start began as not started after it was rolled back; nothing retries that. */
export function activationJournal(
  target: TargetRecord,
  mode: "explicit" | "automatic",
  deps: Pick<Deps, "store" | "now" | "id">,
): ActivationJournal & { failed(error: unknown): Promise<void> } {
  const begun: string[] = [];
  return {
    async starting(service) {
      const incarnation = deps.id();
      const current = currentRun(target, service);
      await saveRun(
        target,
        service,
        {
          deployment: target.plan.workspacePath,
          intent: "running",
          incarnation,
          attempts:
            mode === "automatic"
              ? [...(current?.attempts ?? []), Date.parse(deps.now())]
              : [],
        },
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

/** Records that an operator stopped the Target: no exit of any of its Services is retried and no retry stays scheduled.
 * Updates `target` in place; the caller saves it before it stops anything. */
export function intendStopped(target: TargetRecord): void {
  for (const [service, run] of Object.entries(target.services ?? {})) {
    const { retryAt: _retryAt, ...rest } = run;
    target.services![service] = { ...rest, intent: "stopped" };
  }
}

/** Records that an operator's up succeeded: a Service it found already running (one an earlier down could not stop, say)
 * is meant to run again too. Updates `target` in place; the caller saves it. */
export function intendRunning(target: TargetRecord): void {
  for (const [service, run] of Object.entries(target.services ?? {}))
    if (run.intent === "stopped")
      target.services![service] = { ...run, intent: "running" };
}

/** One pass over a Target meant to run. A running Service is left alone, which is how a process that survived the daemon is
 * adopted. A stopped one has its outcome recorded once, then is started again only when its policy retries that known outcome,
 * its budget allows and its backoff has passed. Returns when the earliest scheduled attempt is due, in Unix milliseconds.
 * A record that cannot be saved ends the Service's pass before anything is started. */
export async function superviseTarget(
  target: TargetRecord,
  deps: Deps,
): Promise<number | undefined> {
  let next: number | undefined;
  for (const component of target.plan.components) {
    if (component.kind !== "managed") continue;
    try {
      const due = await superviseService(target, component, deps);
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
): Promise<number | undefined> {
  const service = component.name;
  // An observation that does not answer within the status budget decides nothing; the pass moves on.
  const [observed] = await boundedObservations(
    [(signal) => deps.observations.process(target, component, signal)],
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  if (observed?.kind === "rejected") throw observed.error;
  if (observed?.kind !== "completed" || observed.value.state !== "stopped")
    return undefined;
  const observation = observed.value;
  let run = currentRun(target, service);
  if (run?.intent === "stopped" || run?.exhausted) return undefined;
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
    await saveRun(target, service, run, deps, exitActivity(service, outcome));
  }
  const outcome = run.outcome!;
  if (!retries(component.restart ?? "always", outcome)) return undefined;
  const now = Date.parse(deps.now());
  if (run.retryAt === undefined) {
    const recent = run.attempts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (recent.length >= RESTART_LIMIT) {
      await saveRun(target, service, { ...run, exhausted: true }, deps, {
        action: "restart",
        outcome: "failed",
        message: `${service} used its ${RESTART_LIMIT} automatic restarts within ${RESTART_WINDOW_MS / 1000} s and stays stopped. Run rig restart ${target.name} once the cause is fixed.`,
      });
      return undefined;
    }
    run = {
      ...run,
      attempts: recent,
      retryAt: Date.parse(outcome.at) + RESTART_BACKOFF_MS * 2 ** recent.length,
    };
    await saveRun(target, service, run, deps);
  }
  if (now < run.retryAt!) return run.retryAt;
  const journal = activationJournal(target, "automatic", deps);
  try {
    await deps.lifecycle.recover(target, service, journal);
  } catch (error) {
    // Every failed attempt spends budget, one refused before anything was spawned too, so a Service that cannot start
    // (a dependency that stays down, say) ends exhausted and visible instead of being asked again forever.
    const code = diagnosticErrorCode(error);
    const { retryAt: _retryAt, ...current } = currentRun(target, service)!;
    await saveRun(
      target,
      service,
      {
        ...current,
        attempts:
          current.incarnation === run.incarnation
            ? [...current.attempts, now]
            : current.attempts,
        outcome: failedAttemptOutcome(error, deps.now()),
      },
      deps,
      {
        action: "restart",
        outcome: "failed",
        message: `${service} could not be started again automatically (${code}).`,
      },
    );
    return await superviseService(target, component, deps);
  }
  const attempts = currentRun(target, service)!.attempts.length;
  await deps.store.update((state) =>
    recordActivity(state, {
      id: deps.id(),
      projectId: target.projectId,
      project: state.projects.find((p) => p.id === target.projectId)?.name,
      target: target.name,
      occurredAt: deps.now(),
      action: "restart",
      outcome: "started",
      message: `${service} was started again automatically (attempt ${attempts} of ${RESTART_LIMIT} within ${RESTART_WINDOW_MS / 1000} s).`,
    }),
  );
  return undefined;
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
  target: Pick<TargetRecord, "services" | "plan" | "desired">,
  component: ManagedComponent,
  observation: ProcessObservation,
): Pick<ComponentReport, "state" | "exit" | "exitCode" | "signal" | "reason"> {
  const run = currentRun(target, component.name);
  if (target.desired !== "running" || run?.intent === "stopped")
    return { state: "stopped", ...(run ? { exit: "requested" } : {}) };
  const outcome = run?.outcome ?? observedOutcome(run, observation, "");
  const again = "Run rig up to start it again.";
  if (outcome.kind === "unknown")
    return {
      state: "failed",
      exit: "unknown",
      reason: `The process is not running and nothing recorded how it ended, so it was not restarted. ${again}`,
    };
  const policy = component.restart ?? "always";
  const pending = retries(policy, outcome) && !run?.exhausted;
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
      ? `${ended}; an automatic restart is scheduled.`
      : run?.exhausted
        ? `${ended} after ${RESTART_LIMIT} automatic restarts within ${RESTART_WINDOW_MS / 1000} s, so it stays stopped. ${again}`
        : outcome.kind === "start-failed"
          ? `${ended}. ${again}`
          : `${ended} and its restart policy is ${policy}, so it stays stopped. ${again}`,
  };
}

function exitActivity(service: string, outcome: ServiceOutcome): Activity {
  if (outcome.kind !== "exited")
    return {
      action: "exit",
      outcome: "failed",
      message: `${service} is not running and nothing recorded how it ended, so it was not started again.`,
    };
  return {
    action: cleanExit(outcome) ? "exit" : "crash",
    outcome: cleanExit(outcome) ? "stopped" : "failed",
    message: `${service} ${describeExit(outcome)}.`,
  };
}

/** "exited with code 3", "was ended by SIGKILL". */
export function describeExit(
  outcome: Extract<ServiceOutcome, { kind: "exited" }>,
): string {
  return outcome.signal === undefined
    ? `exited with code ${outcome.exitCode}`
    : `was ended by ${outcome.signal}`;
}
