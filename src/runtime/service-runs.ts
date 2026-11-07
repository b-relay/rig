import type { ManagedComponent } from "../config/types";
import { recordActivity, type ServiceActivity } from "../domain/activity";
import type { HostRestart } from "../domain/host-session";
import { RigError, diagnosticErrorCode } from "../domain/errors";
import {
  spentAttempts,
  withAttempts,
  withoutRetry,
  type RestartBudget,
} from "../domain/restart-policy";
import {
  currentRun,
  type RuntimeState,
  type Served,
  type ServiceRun,
  type ServiceSource,
  type TargetRecord,
} from "../domain/runtime";
import { preparedBuild, serviceDefinition } from "../domain/service-definition";
import type { RuntimeDependencies } from "./contracts";
import type { ActivationJournal, StartEvidence } from "./lifecycle";
import type { ServedReceipt } from "./served";

/** The owner of each Service's run record: what a start journals, an operator's intent, and the one-Service writes
 * supervision and health restarts make. */

type Deps = Pick<RuntimeDependencies, "store" | "now" | "id">;

/** The record a Service of `target` gets before anything was recorded about it. */
export function untrackedRun(target: Pick<TargetRecord, "plan">): ServiceRun {
  return {
    deployment: target.plan.workspacePath,
    intent: "running",
    attempts: [],
  };
}

/** Saves one Service's record with an optional Activity entry, in one write that touches nothing else of the saved Target:
 * restart evidence never rewrites a plan, a preparation or a pending transition.
 * `target` is updated in place and put back when the store refuses, so memory never claims more than disk. */
export async function saveRun(
  target: TargetRecord,
  service: string,
  run: ServiceRun,
  deps: Deps,
  activity?: ServiceActivity,
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
          component: { kind: "service", name: service },
          occurredAt: deps.now(),
          ...activity,
        })),
  );
}

/** Saves the records of `runs` (by Service name) and whatever `alongside` records in one write, so all of it is saved or
 * none is; of the saved Target only those Services' records change. Rejects TARGET_UNKNOWN when the Target is no longer
 * recorded. `target` is updated in place and put back when the store refuses, so memory never claims more than disk. */
export async function saveRuns(
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
 * `failed` marks the Services an explicit start began as not started after it was rolled back; nothing retries that.
 * What the start served is kept in `receipt` (ADR 0020), and on a deploy's candidate, the Target with a `recovery`, also
 * saved there as `recovery.served`: before its publication, durably, and from and until when, as best it can. */
export function activationJournal(
  target: TargetRecord,
  mode: "explicit" | RestartBudget | "health",
  deps: Deps,
  options: {
    afterHostRestart?: HostRestart;
    healthStretch?: NonNullable<ServiceRun["healthStretch"]>;
    /** When an automatic attempt was made (Unix milliseconds), as its budget records it; now when absent. */
    attemptAt?: number;
    receipt?: ServedReceipt;
  } = {},
): ActivationJournal & { failed(error: unknown): Promise<void> } {
  const begun: string[] = [];
  const receipt = options.receipt ?? {};
  /** Keeps `served` in `receipt` and on the candidate, in memory first: what memory says the candidate served stays true
   * whatever the disk says. */
  const serve = async (served: Served) => {
    receipt.served = served;
    if (!target.recovery) return;
    target.recovery.served = served;
    await deps.store.update((state) => {
      const saved = state.targets.find((t) => t.id === target.id);
      if (saved?.recovery) saved.recovery.served = served;
    });
  };
  return {
    async publishing() {
      if (receipt.served) return;
      // Durable before the proxy is asked: a candidate is never served with nothing on disk to say it may have been.
      try {
        await serve({});
      } catch (error) {
        delete receipt.served;
        if (target.recovery) delete target.recovery.served;
        throw error;
      }
    },
    async published() {
      if (!receipt.served || receipt.served.from !== undefined) return;
      await serve({ ...receipt.served, from: deps.now() }).catch(() => {});
    },
    async withdrawn() {
      if (!receipt.served || receipt.served.until !== undefined) return;
      await serve({ ...receipt.served, until: deps.now() }).catch(() => {});
    },
    async starting(service, evidence) {
      const incarnation = deps.id();
      const current = currentRun(target, service);
      const source = startSource(target, service, evidence);
      const fresh: ServiceRun = {
        deployment: target.plan.workspacePath,
        ...(source ? { source } : {}),
        intent: "running",
        incarnation,
        attempts: [],
        ...(mode === "explicit" && options.afterHostRestart
          ? { startedAfterHostRestart: options.afterHostRestart }
          : {}),
      };
      const run: ServiceRun =
        mode === "explicit"
          ? fresh
          : mode === "health"
            ? {
                ...carriedOver(fresh, current),
                ...(options.healthStretch
                  ? { healthStretch: options.healthStretch }
                  : {}),
              }
            : automaticStart(
                fresh,
                current,
                mode,
                options.attemptAt ?? Date.parse(deps.now()),
              );
      // In the same write, the start takes the next value of the state's startSeq, which orders it after every Host
      // restart recorded before it: such a restart's stop never applies to this run.
      await saveRuns(target, { [service]: run }, deps, (state) => {
        const next = (state.startSeq ?? 0) + 1;
        state.startSeq = next;
        run.startSeq = next;
      });
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
/** Pure: where a start of `service` from `target`'s plan runs and what from (ADR 0016), or nothing when the plan has no
 * such Service. Every start runs from the Target's current plan, so this is its checkout and Commit. */
function startSource(
  target: Pick<TargetRecord, "plan" | "commit">,
  service: string,
  evidence: StartEvidence | undefined,
): ServiceSource | undefined {
  const component = target.plan.components.find(
    (candidate): candidate is ManagedComponent =>
      candidate.kind === "managed" && candidate.name === service,
  );
  if (!component) return undefined;
  const commit = target.commit ?? target.plan.commit;
  return {
    checkout: target.plan.workspacePath,
    ...(commit ? { commit } : {}),
    definition: serviceDefinition(target.plan, component),
    ...(evidence?.environment !== undefined
      ? { environment: evidence.environment }
      : {}),
    ...((build) => (build !== undefined ? { build } : {}))(
      preparedBuild(target, service),
    ),
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
  for (const [service, run] of Object.entries(target.services ?? {}))
    target.services![service] = { ...withoutRetry(run), intent: "stopped" };
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

/** Records on the Service's current run the unhealthy stretch a health restart is about to continue. */
export async function recordHealthStretch(
  target: TargetRecord,
  service: string,
  stretch: NonNullable<ServiceRun["healthStretch"]>,
  deps: Deps,
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
