import { activationJournal, intendStopped } from "./supervision";
import type { ManagedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import { rigCommand, type RecordedTarget } from "../domain/rig-command";
import { boundedObservations } from "./bounded-observations";
import { within } from "../domain/paths";
import { holdCheckout } from "./jobs";
import { ownedRevision } from "./revisions";
import {
  asRecorded,
  decideKept,
  recordedRun,
  servicesToObserve,
  type KeepDecision,
  type KeepFacts,
} from "./keep-decision";
import { RigError, failureCauses, retainFailureCauses } from "../domain/errors";
import { isStopDetached } from "../domain/stop-budget";
import type { RuntimeDependencies } from "./contracts";
import { persistTarget } from "./targets";
import { uncertainAttempt } from "./lifecycle";
import { prepareTarget } from "./preparation";
/** Unresolved recovery must be rejected before accepting any deployment outcome. */
export function assertDeploymentRecovered(
  previous: (Pick<TargetRecord, "recovery"> & RecordedTarget) | undefined,
): void {
  if (previous?.recovery)
    throw new RigError(
      "DEPLOY_RECOVERY",
      "The previous deployment has an unresolved transition.",
      `Run ${rigCommand("down", { target: previous })} to finish stopping both plans before deploying again.`,
    );
}
/** What a deploy asks of its activation. */
export interface DeploymentIntent {
  /** `start` starts the new plan; `prepare` (`--no-up`) leaves every Service stopped. */
  activation: "start" | "prepare";
  operationId?: string;
  /** `--force`: build a fresh Deployment and keep no Service running. */
  force?: boolean;
  /** The Project repository, whose Commits a deploy compares for each Service's watched files; without it every Service
   * whose files the comparison would decide restarts. */
  repository?: string;
}
/** A deployment that was activated, and what it did with each Service. */
export interface ActivatedDeployment {
  target: TargetRecord;
  decision: KeepDecision;
}
/** `deployCandidate`, for callers that need only the Target it leaves. */
export async function activateDeployment(
  candidate: TargetRecord,
  previous: TargetRecord | undefined,
  intent: DeploymentIntent,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  return (await deployCandidate(candidate, previous, intent, deps)).target;
}
/** The saved recovery record owns both plans until candidate activation or verified rollback finishes.
 * The candidate is prepared (dependencies, then every build unit) while the previous plan keeps serving, so a failed
 * build never stops it; `prepare` ends there, leaving every Service stopped. A deploy that starts its Target keeps each
 * Service whose definition, environment and watched files are unchanged running (ADR 0016): the new Deployment adopts its
 * run, and only the others are stopped and started. */
export async function deployCandidate(
  candidate: TargetRecord,
  previous: TargetRecord | undefined,
  intent: DeploymentIntent,
  deps: RuntimeDependencies,
): Promise<ActivatedDeployment> {
  try {
    return await activate(candidate, previous, intent, deps);
  } finally {
    // The route check reserved the candidate's hostnames. Once the deployment is decided, on every path (activated, prepared
    // without starting, failed or rolled back), the reservation goes: an activated route already holds them in the route file.
    await deps.lifecycle.releaseRoute(candidate).catch(() => {});
  }
}
async function activate(
  candidate: TargetRecord,
  previous: TargetRecord | undefined,
  intent: DeploymentIntent,
  deps: RuntimeDependencies,
): Promise<ActivatedDeployment> {
  assertDeploymentRecovered(previous);
  candidate.deploymentIncomplete = true;
  candidate.recovery = {
    ...(intent.operationId ? { operationId: intent.operationId } : {}),
    plan: previous?.plan ?? candidate.plan,
    ...(previous?.preparation ? { preparation: previous.preparation } : {}),
    branch: previous?.branch ?? candidate.branch,
    commit: previous?.commit ?? candidate.commit,
    desired: previous?.desired ?? "stopped",
    deploymentIncomplete: previous ? previous.deploymentIncomplete : true,
    stage: "pending",
  };
  // The previous runs come along, so the stored Target keeps naming the processes that run in earlier checkouts from its
  // first write on, and a sweep that runs while the candidate builds never gives such a checkout back. They describe
  // another Deployment until the candidate adopts or replaces them (`currentRun` ignores them).
  if (previous?.services)
    candidate.services = { ...previous.services, ...candidate.services };
  const checkpoint = await deps.lifecycle.checkpoint(candidate, previous);
  let commitDecided = false,
    transitioned = false;
  /** The Services kept running, by name, with the process each was kept with. */
  const kept = new Map<string, string | undefined>();
  try {
    await persistTarget(candidate, deps.store);
  } catch (error) {
    try {
      await checkpoint.rollback();
    } catch (recoveryError) {
      throw retainFailureCauses(recoveryError, error, recoveryError);
    }
    throw error;
  }
  try {
    await prepareTarget(candidate, "all", deps);
    // Before anything stops: a route that cannot be published would leave neither Deployment serving.
    await deps.lifecycle.checkRoute(candidate);
    const decision = previous
      ? await decideKeeping(candidate, previous, intent, deps)
      : firstDecision(candidate);
    if (previous && decision.kept.length) {
      // Written before the first stop, so a rigd that stops mid-deploy knows which processes belong to which plan.
      adopt(candidate, previous, decision.kept);
      for (const service of decision.kept)
        kept.set(service, candidate.services![service]!.incarnation);
      await persistTarget(candidate, deps.store);
    }
    transitioned = true;
    if (previous) {
      // In reverse dependency order; restarts spread to dependents, so no kept Service depends on one that stops.
      await deps.lifecycle.down(withoutServices(previous, kept.keys()));
      await deps.lifecycle.retireSuperseded(previous, candidate);
    }
    if (intent.activation === "start") {
      await deps.lifecycle.up(
        candidate,
        checkpoint,
        activationJournal(candidate, "explicit", deps),
      );
      candidate.desired = "running";
    }
    const committing = {
      ...candidate,
      recovery: { ...candidate.recovery!, stage: "committing" as const },
    };
    delete committing.deploymentIncomplete;
    await persistTarget(committing, deps.store);
    commitDecided = true;
    await checkpoint.commit();
    const completed: TargetRecord = { ...committing };
    delete completed.recovery;
    // The previous runs the candidate carried and neither adopted nor replaced describe processes this deploy stopped
    // (every Service of the previous plan it did not keep). A run of any other Service is kept: nothing here confirmed its
    // process gone, so it still holds the checkout it names until a sweep sees it gone.
    const stopped = new Set(
      (previous?.plan.components ?? []).flatMap((component) =>
        component.kind === "managed" ? [component.name] : [],
      ),
    );
    if (completed.services)
      completed.services = Object.fromEntries(
        Object.entries(completed.services).filter(
          ([service, run]) =>
            run.deployment === completed.plan.workspacePath ||
            !stopped.has(service),
        ),
      );
    // A kept Service that ended meanwhile was started again from the candidate's checkout: it was not kept after all.
    const stillKept = decision.kept.filter(
      (service) =>
        completed.services?.[service]?.incarnation === kept.get(service),
    );
    const outcome: KeepDecision = {
      ...decision,
      kept: stillKept,
      restarted: [
        ...decision.restarted,
        ...decision.kept
          .filter((service) => !stillKept.includes(service))
          .map((service) => ({ service, reason: "not-running" as const })),
      ],
    };
    // The checkouts kept Services run in are recorded as held in the same write, so a rigd that stops right after it
    // still finds them to give back.
    await deps.store.update((state) => {
      const index = state.targets.findIndex((t) => t.id === completed.id);
      if (index === -1) state.targets.push(completed);
      else state.targets[index] = completed;
      for (const workspace of heldBy(completed, stillKept))
        holdCheckout(state, {
          target: completed.id,
          project: completed.projectId,
          workspace,
        });
    });
    return { target: completed, decision: outcome };
  } catch (error) {
    if (commitDecided)
      throw new RigError(
        "DEPLOY_COMMIT_PENDING",
        "The deployment was activated, but its commit finalization is incomplete.",
        `Run ${rigCommand("down", { target: candidate })} to finish the recorded commit without restoring the previous build.`,
        {},
        failureCauses(error),
      );
    // rigd is shutting down mid-stop: the transition stays pending, as after a crash, and rig down finishes it.
    if (isStopDetached(error)) throw error;
    try {
      // A failed preparation changed nothing: the previous Deployment, whose process keys the candidate shares, keeps running.
      // Only what the candidate started stops: a kept Service still running the process it was kept with is never
      // stopped by a failed deploy, and the previous plan's start below finds it running.
      if (transitioned) {
        // A kept Service whose start check failed in the candidate's start is restarted from the previous plan, like the
        // Services the candidate started; one that ended meanwhile was started by the candidate.
        // Its dependents go with it, so no Service left running depends on one that restarts.
        const touched = dependentsOf(candidate, failedService(error));
        const untouched = [...kept].flatMap(([service, incarnation]) =>
          candidate.services?.[service]?.incarnation === incarnation &&
          !touched.has(service)
            ? [service]
            : [],
        );
        await deps.lifecycle.down(withoutServices(candidate, untouched));
        if (previous)
          await deps.lifecycle.down(withoutServices(previous, untouched));
      }
      // The previous plan's route comes back withheld for every Service just stopped (the effect checkpoint restores it so).
      await checkpoint.rollback();
    } catch (recoveryError) {
      candidate.recovery ??= {
        plan: candidate.plan,
        branch: candidate.branch,
        commit: candidate.commit,
        desired: "stopped",
        stage: "blocked",
      };
      candidate.recovery.stage = "blocked";
      candidate.desired = "stopped";
      intendStopped(candidate);
      try {
        await persistTarget(candidate, deps.store);
      } catch (persistenceError) {
        throw retainFailureCauses(persistenceError, error, persistenceError);
      }
      throw new RigError(
        "DEPLOY_ROLLBACK_BLOCKED",
        "Deployment failed and process cleanup could not be verified, or saved effects could not be restored.",
        `Run ${rigCommand("down", { target: candidate })} and inspect its logs before retrying.`,
        {},
        failureCauses(error, recoveryError),
      );
    }
    if (previous) {
      try {
        if (transitioned && previous.desired === "running")
          await deps.lifecycle.up(
            previous,
            undefined,
            activationJournal(previous, "explicit", deps),
          );
        const uncertain = uncertainAttempt(candidate);
        await persistTarget(
          uncertain ? { ...previous, uncertainBuild: uncertain } : previous,
          deps.store,
        );
      } catch (recoveryError) {
        if (candidate.recovery) candidate.recovery.stage = "blocked";
        try {
          await persistTarget(candidate, deps.store);
        } catch (persistenceError) {
          throw retainFailureCauses(persistenceError, error, persistenceError);
        }
        throw new RigError(
          "DEPLOY_RESTORE_FAILED",
          "The deployment failed and its previous plan could not be restored.",
          `Run ${rigCommand("down", { target: candidate })} and inspect its logs before retrying.`,
          {},
          failureCauses(error, recoveryError),
        );
      }
    } else {
      candidate.desired = "stopped";
      intendStopped(candidate);
      delete candidate.recovery;
      try {
        await persistTarget(candidate, deps.store);
      } catch (recoveryError) {
        throw retainFailureCauses(recoveryError, error, recoveryError);
      }
    }
    throw error;
  }
}
/** What a deploy does with each Service, from what it observes of the previous Deployment's processes (ADR 0016). Only
 * the Services the records leave open are observed: their process, cached health, the environment they would start with
 * from the new plan, and whether a file they watch changed between their run's Commit and the new one. Anything that
 * cannot be established counts against keeping. */
async function decideKeeping(
  candidate: TargetRecord,
  previous: TargetRecord,
  intent: DeploymentIntent,
  deps: RuntimeDependencies,
): Promise<KeepDecision> {
  const input = {
    previous,
    candidate,
    keep: intent.activation === "start" && !intent.force,
  };
  const facts = new Map<string, KeepFacts>();
  for (const service of servicesToObserve(input))
    facts.set(
      service,
      await observeKeepFacts(service, candidate, previous, intent, deps),
    );
  return decideKept({ ...input, facts });
}
/** What a deploy observes about one Service it may keep, stopping at the first fact that already decides it. */
async function observeKeepFacts(
  service: string,
  candidate: TargetRecord,
  previous: TargetRecord,
  intent: DeploymentIntent,
  deps: RuntimeDependencies,
): Promise<KeepFacts> {
  const run = recordedRun(previous, service)!;
  const component = managedService(candidate, service)!;
  const [observed] = await boundedObservations(
    [(signal) => deps.observations.process(previous, component, signal)],
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  if (observed?.kind !== "completed") return {};
  const process = {
    state: observed.value.state,
    ...(observed.value.incarnation !== undefined
      ? { incarnation: observed.value.incarnation }
      : {}),
  };
  if (process.state !== "running" || process.incarnation !== run.incarnation)
    return { process };
  if (deps.healthResults?.(previous, service)?.status === "unhealthy")
    return { process, unhealthy: true };
  // From the new plan in the form the run was recorded in, as its own digest was taken.
  const environment = await deps.lifecycle
    .environmentDigest(
      asRecorded(candidate, run, service) ?? candidate,
      service,
    )
    .catch(() => undefined);
  if (environment === undefined || environment !== run.source.environment)
    return { process, ...(environment ? { environment } : {}) };
  return {
    process,
    environment,
    ...((await watchedChange(
      component,
      run.source.commit,
      candidate,
      intent,
      deps,
    )) ?? {}),
  };
}
/** Whether a file `component` watches changed between the Commit `from` its process started from and the candidate's;
 * nothing when that cannot be told. An empty watch list watches nothing, so nothing changed. */
async function watchedChange(
  component: ManagedComponent,
  from: string | undefined,
  candidate: TargetRecord,
  intent: DeploymentIntent,
  deps: RuntimeDependencies,
): Promise<{ changed: boolean } | undefined> {
  if (component.watch?.length === 0) return { changed: false };
  if (!intent.repository || !from || !candidate.commit) return undefined;
  try {
    return {
      changed: await deps.sources.changed({
        repository: intent.repository,
        from,
        to: candidate.commit,
        ...(component.watch ? { paths: component.watch } : {}),
      }),
    };
  } catch {
    return undefined;
  }
}
/** A warning for each `watch` entry of `target`'s plan that matches no tracked file at its Commit: a mistyped path would let
 * a later deploy keep the Service running on a file that changed. Best effort: what cannot be listed says nothing. */
export async function watchWarnings(
  target: Pick<TargetRecord, "plan" | "commit">,
  repository: string,
  deps: Pick<RuntimeDependencies, "sources">,
): Promise<string[]> {
  const commit = target.commit;
  if (!commit) return [];
  const warnings: string[] = [];
  for (const component of target.plan.components) {
    if (component.kind !== "managed" || !component.watch?.length) continue;
    const missing = await deps.sources
      .unmatched({ repository, commit, paths: component.watch })
      .catch(() => []);
    for (const path of missing)
      warnings.push(
        `services.${component.name}.watch entry '${path}' matches no tracked file at ${commit.slice(0, 7)}, so a change there would never restart ${component.name}. Check its spelling and case in rig.yaml.`,
      );
  }
  return warnings;
}
/** The earlier checkouts the kept Services of `target` run in, which the Target holds while they run. */
function heldBy(target: TargetRecord, kept: readonly string[]): string[] {
  const owned = ownedRevision(target) !== undefined;
  return [
    ...new Set(
      kept.flatMap((service) => {
        const checkout = target.services?.[service]?.source?.checkout;
        return owned &&
          checkout !== undefined &&
          checkout !== target.plan.workspacePath &&
          target.sourceRoot !== undefined &&
          within(target.sourceRoot, checkout)
          ? [checkout]
          : [];
      }),
    ),
  ];
}
/** `service` and every Service of `target`'s plan that depends on it, transitively; empty without a Service. */
function dependentsOf(
  target: TargetRecord,
  service: string | undefined,
): Set<string> {
  const found = new Set<string>(service !== undefined ? [service] : []);
  if (!found.size) return found;
  // Plans list Services in dependency order, so one pass reaches every dependent.
  for (const component of target.plan.components)
    if (
      component.kind === "managed" &&
      component.dependsOn.some((name) => found.has(name))
    )
      found.add(component.name);
  return found;
}
/** The Service a failed start check names, if any. A thrown value may be anything, even a Proxy that throws when it is
 * inspected: that names none. */
function failedService(error: unknown): string | undefined {
  try {
    const component =
      error instanceof RigError ? error.details.component : undefined;
    return typeof component === "string" ? component : undefined;
  } catch {
    return undefined;
  }
}
/** A first deploy starts every Service. */
function firstDecision(candidate: TargetRecord): KeepDecision {
  return {
    kept: [],
    restarted: candidate.plan.components.flatMap((component) =>
      component.kind === "managed"
        ? [{ service: component.name, reason: "new" as const }]
        : [],
    ),
    removed: [],
  };
}
/** The new Deployment adopts the runs of `kept`: each keeps its process, budgets, unhealthy stretch and `source` (the
 * earlier checkout it runs in), and now belongs to the candidate's plan. Updates `candidate` in place. */
function adopt(
  candidate: TargetRecord,
  previous: TargetRecord,
  kept: readonly string[],
): void {
  candidate.services = {
    ...candidate.services,
    ...Object.fromEntries(
      kept.map((service) => [
        service,
        {
          ...previous.services![service]!,
          deployment: candidate.plan.workspacePath,
        },
      ]),
    ),
  };
}
/** `target` as one whose plan lacks the Services `names`, so stopping it leaves them running. */
function withoutServices(
  target: TargetRecord,
  names: Iterable<string>,
): TargetRecord {
  const left = new Set(names);
  if (!left.size) return target;
  return {
    ...target,
    plan: {
      ...target.plan,
      components: target.plan.components.filter(
        (component) =>
          component.kind !== "managed" || !left.has(component.name),
      ),
    },
  };
}
function managedService(
  target: TargetRecord,
  service: string,
): ManagedComponent | undefined {
  return target.plan.components.find(
    (component): component is ManagedComponent =>
      component.kind === "managed" && component.name === service,
  );
}
/** Explicit down is the recovery path; it stops both recorded plans (and a build a daemon that died left running) before
 * clearing the transition. Resolves the Target as now recorded, and `stopped` when either stop ended a process. The
 * checkout of the plan it drops is held in the same write that drops that plan, so it is given back once nothing runs in
 * it, by the down that follows or by the sweep. */
export async function stopForRecovery(
  target: TargetRecord,
  deps: RuntimeDependencies,
): Promise<{ target: TargetRecord; outcome: "stopped" | "unchanged" }> {
  if (!target.recovery) return { target, outcome: "unchanged" };
  // Both plans' processes stop here under one set of process keys, and the route may name either plan's ports: all of it
  // is withheld before either plan stops anything.
  await deps.lifecycle.withhold(target);
  const stops = [await deps.lifecycle.down(target)];
  const outcome = () =>
    stops.some((stop) => stop.outcome === "stopped") ? "stopped" : "unchanged";
  if (target.recovery.stage === "committing") {
    await deps.lifecycle.commitEffects(target);
    const completed = { ...target, desired: "stopped" as const };
    delete completed.recovery;
    await settleRecovery(
      completed,
      { ...target, plan: target.recovery.plan },
      deps,
    );
    return { target: completed, outcome: outcome() };
  }
  const previous: TargetRecord = {
    ...target,
    plan: target.recovery.plan,
    // A first deployment recovers to its own plan, and keeps what is known about its builds.
    preparation:
      target.recovery.plan.workspacePath === target.plan.workspacePath
        ? target.preparation
        : target.recovery.preparation,
    branch: target.recovery.branch,
    commit: target.recovery.commit,
    desired: "stopped",
    deploymentIncomplete: target.recovery.deploymentIncomplete,
  };
  delete previous.recovery;
  if (!previous.preparation) delete previous.preparation;
  if (target.recovery.plan.workspacePath !== target.plan.workspacePath) {
    const uncertain = uncertainAttempt(target);
    if (uncertain) previous.uncertainBuild = uncertain;
  }
  stops.push(await deps.lifecycle.down(previous));
  await deps.lifecycle.restoreEffects(target);
  await settleRecovery(previous, target, deps);
  return { target: previous, outcome: outcome() };
}
/** Saves `settled`, the Target a recovery leaves, and holds the checkout of `dropped`, the plan it no longer records, in
 * the same write: a deployed Target's own revision that is not `settled`'s is never left on disk with nothing naming it. */
async function settleRecovery(
  settled: TargetRecord,
  dropped: TargetRecord,
  deps: Pick<RuntimeDependencies, "store">,
): Promise<void> {
  const workspace = ownedRevision(dropped);
  await deps.store.update((state) => {
    const index = state.targets.findIndex((t) => t.id === settled.id);
    if (index === -1) state.targets.push(settled);
    else state.targets[index] = settled;
    if (workspace !== undefined && workspace !== settled.plan.workspacePath)
      holdCheckout(state, {
        target: settled.id,
        project: settled.projectId,
        workspace,
      });
  });
}
