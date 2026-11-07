import type { ManagedComponent } from "../config/types";
import { DEFAULT_RESTART_POLICY } from "../config/plan-defaults";
import { recordActivity } from "../domain/activity";
import { clockOr, placed, type Clock } from "../domain/clock";
import type { HostRestart } from "../domain/host-session";
import { diagnosticErrorCode } from "../domain/errors";
import {
  DEFAULT_SUPERVISION_SCOPE,
  failedAttempt,
  failedStartRecorded,
  healthOwnsStart,
  inWindow,
  observedOutcome,
  recordKeepsStopped,
  restartBudget,
  scheduleAttempt,
  spentAttempts,
  stoppedByHostRestart,
  withoutRetry,
  type RestartBudget,
  type SupervisionScope,
} from "../domain/restart-policy";
import {
  exhaustedActivity,
  exitActivity,
  failedAttemptActivity,
  restartedActivity,
  waitingActivity,
} from "../domain/restart-wording";
import {
  currentRun,
  type RuntimeState,
  type ServiceOutcome,
  type ServiceRun,
  type TargetRecord,
} from "../domain/runtime";
import type { ProcessObservation } from "../providers/contracts";
import { isStopDetached } from "../domain/stop-budget";
import { boundedObservations } from "./bounded-observations";
import { observeLivePorts } from "./route-guard";
import { plannedRoutes } from "./ports";
import type { RuntimeDependencies } from "./contracts";
import {
  activationJournal,
  saveRun,
  saveRuns,
  untrackedRun,
} from "./service-runs";

/** Supervision: observes each Service, records what it sees through the run journal, and starts again what the restart
 * policy (`domain/restart-policy`) says to. Status and Activity wording is `domain/restart-wording`'s. */

// This module's earlier exports, now owned elsewhere.
export {
  DEFAULT_SUPERVISION_SCOPE,
  RESTART_BACKOFF_MS,
  RESTART_LIMIT,
  RESTART_WINDOW_MS,
  UNKNOWN_EXIT_RESTART_BACKOFF_MS,
  UNKNOWN_EXIT_RESTART_LIMIT,
  UNKNOWN_EXIT_RESTART_WINDOW_MS,
  cleanExit,
  observedOutcome,
  restartBudget,
  scheduleAttempt,
  supervisionScope,
  type RestartBudget,
  type SupervisionScope,
} from "../domain/restart-policy";
export {
  describeExit,
  runningNote,
  stoppedStanding,
} from "../domain/restart-wording";
export { currentRun } from "../domain/runtime";
export {
  activationJournal,
  intendRunning,
  intendStopped,
  recordHealthStretch,
} from "./service-runs";

type Deps = Pick<
  RuntimeDependencies,
  | "store"
  | "now"
  | "clock"
  | "id"
  | "lifecycle"
  | "observations"
  | "observationBudgetMs"
  | "observationDeadline"
  | "diagnostic"
>;

/** Where on the elapsed clock this rigd saw each Service's restart evidence, by `<target id>:<service>`: the exit its next
 * automatic attempt waits after, and the attempts each budget counts. Kept beside the records and matched to them by the
 * process that exited, and by position: a budget's marks are the record's attempts, one for one in order, pruned with
 * them, never matched by a wall-clock time, which a correction can repeat. What a record holds that this rigd did not see
 * happen (a previous rigd wrote it) is placed by its wall-clock age (`placed`). */
export type RestartMarks = Map<string, ServiceMarks>;
interface Mark {
  at: number;
  mark: number;
}
interface ServiceMarks {
  exit?: { incarnation: string | undefined; at: string; mark: number };
  attempts: Record<RestartBudget, BudgetMarks>;
}
/** One budget's marks: one per attempt its record lists, in order, and the attempt this rigd made last from it until the
 * record shows that spent. */
interface BudgetMarks {
  marks: Mark[];
  made?: Mark;
}
function serviceMarks(marks: RestartMarks, key: string): ServiceMarks {
  let entry = marks.get(key);
  if (!entry)
    marks.set(
      key,
      (entry = {
        attempts: {
          "known-exit": { marks: [] },
          "unknown-exit": { marks: [] },
        },
      }),
    );
  return entry;
}
/** The elapsed reading of the exit `run` records: the one this rigd saw for that process, else placed now. */
function exitMark(
  entry: ServiceMarks,
  run: ServiceRun & { outcome: ServiceOutcome },
  clock: Clock,
): number {
  const known = entry.exit;
  if (
    known !== undefined &&
    known.incarnation === run.incarnation &&
    known.at === run.outcome.at
  )
    return known.mark;
  const mark = placed(clock, Date.parse(run.outcome.at));
  entry.exit = { incarnation: run.incarnation, at: run.outcome.at, mark };
  return mark;
}
/** The marks of the attempts `run` spent from `budget`, one for one in order. A budget's record only gains the attempt this
 * rigd made last from it (one more than the marks hold) and loses its oldest, so it is the tail of the marks, with that
 * attempt when it is one longer: those marks are kept. A record that is not (a previous rigd wrote it, or another writer
 * reset it) has its attempts placed now. */
function attemptMarks(
  entry: ServiceMarks,
  run: ServiceRun,
  budget: RestartBudget,
  clock: Clock,
): Mark[] {
  const recorded = spentAttempts(run, budget);
  const own = entry.attempts[budget];
  const timed =
    own.made && recorded.length === own.marks.length + 1
      ? [...own.marks, own.made]
      : own.marks;
  const offset = timed.length - recorded.length;
  const marks =
    offset >= 0 &&
    recorded.every((at, index) => timed[offset + index]!.at === at)
      ? timed.slice(offset)
      : recorded.map((at) => ({ at, mark: placed(clock, at) }));
  entry.attempts[budget] = { marks };
  return marks;
}

/** Records, right after rigd detected `restart`, that each Service of `target` (a Working copy or Preview meant to run) not
 * seen running was stopped by it (`stoppedByHostRestart`), so neither its policy nor an unknown-exit retry starts it again
 * before an explicit start (see `supervisionScope`). No retry stays scheduled. A Service seen running survived and is left
 * alone; one whose observation does not answer within the status budget is counted as stopped, since a restart ends every
 * process. Writes no Activity: the restart's own entry says why.
 * The Caddy that came back with the Host still reaches the ports of the Services it stopped, which any program may bind
 * now, so the paths of those seen stopped are withheld first, until a verified start publishes them again; while they
 * cannot be, nothing is recorded and the caller tries again. One only not seen running may have survived a new login, so
 * its paths wait for a later pass to see it stopped (`withholdStoppedServices`).
 * The records, and whatever `alongside` records, are saved in one write. Returns whether they were saved; a failure goes
 * to the diagnostic log. */
export async function recordStoppedByHostRestart(
  target: TargetRecord,
  restart: HostRestart,
  deps: Deps,
  alongside?: (state: RuntimeState) => void,
  /** Which runs the restart stopped; a run started since it is not touched. All when absent. */
  stoppedBy?: (service: string, run: ServiceRun | undefined) => boolean,
): Promise<boolean> {
  return await settleStopped(
    target,
    deps,
    (component, run) =>
      (!stoppedBy || stoppedBy(component.name, run)) &&
      stoppedByHostRestart(component, run)
        ? { kind: "unknown", hostRestart: restart, at: deps.now() }
        : undefined,
    alongside,
    (_services, stopped) => deps.lifecycle.withhold(target, stopped),
  );
}

/** Records, after an explicit start of `target` failed, that each Service not seen running was not started
 * (`failedStartRecorded`): nothing retries it automatically before the next explicit start, and status reports it failed.
 * An earlier start's failure is replaced, so status names what the Target needs now. `alongside` is recorded in the same
 * write, so the failure and whatever the caller records with it are saved together or not at all. Returns whether they
 * were saved. */
export async function recordFailedStart(
  target: TargetRecord,
  error: unknown,
  deps: Deps,
  alongside?: (state: RuntimeState) => void,
  /** Told the Services about to be recorded, and those of them seen stopped, before they are; nothing is saved when it
   * fails. */
  beforeSaving?: (services: string[], stopped: string[]) => Promise<void>,
): Promise<boolean> {
  const errorCode = diagnosticErrorCode(error);
  return await settleStopped(
    target,
    deps,
    (_component, run) =>
      failedStartRecorded(run, errorCode)
        ? { kind: "start-failed", errorCode, at: deps.now() }
        : undefined,
    alongside,
    beforeSaving,
  );
}

/** Withholds the paths of each Service of `target` seen stopped now whose record says supervision will not (see
 * `recordKeepsStopped`): nothing listens on its ports, which any program may bind, and an earlier rigd may have settled it
 * with its paths still published. A Service withheld so joins `checked` and is not looked at again until its record no
 * longer keeps it stopped; one seen running is looked at again by the next call, so its later stop is seen too. Resolves
 * the Services whose state could not be established (unknown, or no answer within the status budget), which decide nothing,
 * for a later call. Fails as withholding a route fails. */
export async function withholdStoppedServices(
  target: TargetRecord,
  checked: Set<string>,
  deps: Pick<
    Deps,
    "lifecycle" | "observations" | "observationBudgetMs" | "observationDeadline"
  >,
): Promise<string[]> {
  const routed = target.plan.components.filter(
    (component): component is ManagedComponent => {
      if (
        component.kind !== "managed" ||
        !plannedRoutes(target.plan).some(
          (route) => route.service === component.name,
        )
      )
        return false;
      if (recordKeepsStopped(currentRun(target, component.name)))
        return !checked.has(component.name);
      checked.delete(component.name);
      return false;
    },
  );
  if (!routed.length) return [];
  const observed = await boundedObservations(
    routed.map(
      (component) => (signal: AbortSignal) =>
        deps.observations.process(target, component, signal),
    ),
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  const seenAs = (state: ProcessObservation["state"]) =>
    routed.flatMap((component, index) => {
      const seen = observed[index]!;
      return seen.kind === "completed" && seen.value.state === state
        ? [component.name]
        : [];
    });
  const [running, stopped] = [seenAs("running"), seenAs("stopped")];
  if (stopped.length) await deps.lifecycle.withhold(target, stopped);
  for (const service of stopped) checked.add(service);
  return routed
    .map((component) => component.name)
    .filter(
      (service) => !running.includes(service) && !stopped.includes(service),
    );
}

/** A pass's one duty for a Target whose recovery is unresolved (ADR 0020): nothing supervises it until `rig down`, so the
 * paths of its Services that exit go here. The route may be either recorded plan's, and both plans' processes run under one
 * set of process keys, so this looks only at the ports live now and at the Services either plan routes to them, whatever
 * their records say. A port goes once every Service behind it is seen stopped, so a path never goes for a Service that may
 * still serve it. Starts nothing and records nothing. Resolves the Services whose state could not be established (unknown,
 * no answer within the status budget, or a failed observation), which decide nothing, for a later call. Fails as reading or
 * withholding a route fails. */
export async function withholdRecoveryPaths(
  target: TargetRecord,
  deps: Pick<
    Deps,
    "lifecycle" | "observations" | "observationBudgetMs" | "observationDeadline"
  >,
): Promise<string[]> {
  if (!target.recovery) return [];
  const live = await deps.lifecycle.livePorts(target);
  if (!live.size) return [];
  // The Target's own plan last: a Service in both plans is one process, observed as the plan it runs under now.
  const seen = await observeLivePorts(
    [{ ...target, plan: target.recovery.plan }, target],
    live,
    deps,
  );
  if (seen.ports.size) await deps.lifecycle.withholdPorts(target, seen.ports);
  return seen.uncertain;
}

/** Gives each managed Service of `target` not seen running the outcome `decide` returns for it, clearing any scheduled
 * retry; `decide` returning nothing leaves the record alone. A Service whose observation does not answer within the status
 * budget counts as not running. `beforeSaving` is told the Services about to get an outcome, and those of them seen stopped
 * rather than only not seen running, and nothing is saved when it fails. The outcomes and whatever `alongside` records are
 * saved in one write, so all of it is saved or none is. Returns whether it was saved; a failure goes to the diagnostic
 * log. */
async function settleStopped(
  target: TargetRecord,
  deps: Deps,
  decide: (
    component: ManagedComponent,
    run: ServiceRun | undefined,
  ) => ServiceOutcome | undefined,
  alongside?: (state: RuntimeState) => void,
  beforeSaving?: (services: string[], stopped: string[]) => Promise<void>,
): Promise<boolean> {
  const runs: Record<string, ServiceRun> = {};
  const stopped: string[] = [];
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
      runs[service] = { ...withoutRetry(run ?? untrackedRun(target)), outcome };
      if (observed?.kind === "completed" && observed.value.state === "stopped")
        stopped.push(service);
    }
    if (Object.keys(runs).length)
      await beforeSaving?.(Object.keys(runs), stopped);
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
 * adopted. A stopped one has its routed paths withheld, then its outcome recorded once, then is started again only when its
 * policy (within `scope`) retries that outcome, the outcome's budget allows and its backoff has passed; the start publishes
 * its paths again once it is verified. A due attempt waits, spending nothing, while a Service it depends on is not running,
 * and after an unknown exit while one of its ports still accepts connections.
 * Returns when the earliest scheduled attempt is due, in Unix milliseconds by the wall clock as it returns.
 * A route that cannot be withheld, or a record that cannot be saved, ends the Service's pass before anything is recorded or
 * started; every other Service is still supervised, and then the first such failure is thrown. */
export async function superviseTarget(
  target: TargetRecord,
  deps: Deps,
  scope: SupervisionScope = DEFAULT_SUPERVISION_SCOPE,
  /** The daemon's restart evidence on the elapsed clock; absent, every recorded time is placed by its wall-clock age. */
  marks: RestartMarks = new Map(),
): Promise<number | undefined> {
  let next: number | undefined;
  const failures: unknown[] = [];
  const services = new Set<string>();
  for (const component of target.plan.components) {
    if (component.kind !== "managed") continue;
    services.add(`${target.id}:${component.name}`);
    try {
      const due = await superviseService(target, component, deps, scope, marks);
      if (due !== undefined) next = Math.min(next ?? due, due);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const key of marks.keys())
    if (key.startsWith(`${target.id}:`) && !services.has(key))
      marks.delete(key);
  if (failures.length) throw failures[0];
  return next;
}

async function superviseService(
  target: TargetRecord,
  component: ManagedComponent,
  deps: Deps,
  scope: SupervisionScope,
  marks: RestartMarks,
): Promise<number | undefined> {
  const service = component.name;
  const clock = clockOr(deps.clock, deps.now);
  const entry = serviceMarks(marks, `${target.id}:${service}`);
  // An observation that does not answer within the status budget decides nothing; the pass moves on. A stopped one means
  // nothing of the start runs any more, the application a capture wrapper last reported included.
  const [observed] = await boundedObservations(
    [(signal) => deps.observations.process(target, component, signal)],
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  if (observed?.kind === "rejected") throw observed.error;
  if (observed?.kind === "completed" && observed.value.state === "running")
    await clearRunningOutcome(target, service, deps);
  if (observed?.kind !== "completed" || observed.value.state !== "stopped")
    return undefined;
  const observation = observed.value;
  let run = currentRun(target, service);
  if (run?.intent === "stopped" || run?.exhausted) return undefined;
  if (healthOwnsStart(component, run)) return undefined;
  const policy = component.restart ?? DEFAULT_RESTART_POLICY;
  if (!run?.outcome) {
    // Nothing of it listens on its ports any more, which any program may bind now: its paths go before its exit is
    // recorded, so a route that cannot be withheld is tried again by the next pass.
    if (plannedRoutes(target.plan).some((route) => route.service === service))
      await deps.lifecycle.withhold(target, [service]);
    const outcome = observedOutcome(
      run,
      observation,
      new Date(clock.now()).toISOString(),
    );
    const mark = clock.elapsed();
    run = { ...(run ?? untrackedRun(target)), outcome };
    await saveRun(
      target,
      service,
      run,
      deps,
      exitActivity(service, outcome, restartBudget(policy, outcome, scope)),
    );
    entry.exit = { incarnation: run.incarnation, at: outcome.at, mark };
  }
  const outcome = run.outcome!;
  const budget = restartBudget(policy, outcome, scope);
  if (!budget) return undefined;
  const endedAt = Date.parse(outcome.at);
  const exited = exitMark(entry, { ...run, outcome }, clock);
  if (run.retryAt === undefined) {
    const marks = attemptMarks(entry, run, budget, clock);
    const ages = marks.map((attempt) => clock.elapsed() - attempt.mark);
    const scheduled = scheduleAttempt(run, budget, endedAt, ages);
    if ("exhausted" in scheduled) {
      await saveRun(
        target,
        service,
        { ...run, exhausted: true },
        deps,
        exhaustedActivity(service, budget, target),
      );
      return undefined;
    }
    run = scheduled.run;
    await saveRun(target, service, run, deps);
    // The record dropped the attempts past the window: so do their marks, at the same positions.
    entry.attempts[budget] = {
      marks: marks.filter((_mark, index) => inWindow(budget, ages[index]!)),
    };
  }
  // The delay after the exit, waited in elapsed time.
  const wait = run.retryAt! - endedAt - (clock.elapsed() - exited);
  if (wait > 0) return clock.now() + wait;
  if (budget === "unknown-exit") {
    // Nothing says the process that ended is not still serving under another identity: its ports must be free first.
    const busy = await listeningPorts(target, component, deps);
    if (busy === undefined) return undefined;
    if (busy.length) {
      await holdBack(target, service, run, { ports: busy }, deps);
      return undefined;
    }
  }
  // The attempt, as recorded and as this rigd saw it happen.
  const attemptAt = clock.now();
  entry.attempts[budget].made = { at: attemptAt, mark: clock.elapsed() };
  const journal = activationJournal(target, budget, deps, { attemptAt });
  let started: Awaited<ReturnType<Deps["lifecycle"]["recover"]>>;
  try {
    started = await deps.lifecycle.recover(target, service, journal);
  } catch (error) {
    // rigd's shutdown cut the attempt short: it is left as a crash leaves it, already spent, for the next daemon to judge by
    // how the process ended.
    if (isStopDetached(error)) return undefined;
    const current = currentRun(target, service)!;
    const failed = failedAttempt(
      current,
      current.incarnation === run.incarnation,
      budget,
      attemptAt,
      error,
      deps.now(),
    );
    if ("waitingFor" in failed) {
      await holdBack(target, service, current, failed.waitingFor, deps);
      return undefined;
    }
    await saveRun(
      target,
      service,
      failed.run,
      deps,
      failedAttemptActivity(service, error),
    );
    return await superviseService(target, component, deps, scope, marks);
  }
  if (started.outcome === "unchanged") {
    // It was found running, started by something else: nothing was spent, and nothing of the ended process stays scheduled.
    const { outcome: _outcome, ...rest } = withoutRetry(
      currentRun(target, service)!,
    );
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
      component: { kind: "service", name: service },
      occurredAt: deps.now(),
      ...restartedActivity(service, budget, attempts),
    }),
  );
  return undefined;
}

/** Drops the outcome a Host restart or a failed start left on a Service seen running after all (its observation had not
 * answered when that was recorded, or its start could not stop it), so its later exit is recorded and judged like any
 * other. */
async function clearRunningOutcome(
  target: TargetRecord,
  service: string,
  deps: Deps,
): Promise<void> {
  const run = currentRun(target, service);
  const outcome = run?.outcome;
  if (
    outcome?.kind !== "start-failed" &&
    (outcome?.kind !== "unknown" || !outcome.hostRestart)
  )
    return;
  const { outcome: _outcome, ...rest } = run!;
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

/** Records why a due attempt waits, with Activity only when the reason changes, so a long wait is one entry. */
async function holdBack(
  target: TargetRecord,
  service: string,
  run: ServiceRun,
  waitingFor: NonNullable<ServiceRun["waitingFor"]>,
  deps: Deps,
): Promise<void> {
  if (JSON.stringify(run.waitingFor) === JSON.stringify(waitingFor)) return;
  await saveRun(
    target,
    service,
    { ...run, waitingFor },
    deps,
    waitingActivity(service, waitingFor),
  );
}
