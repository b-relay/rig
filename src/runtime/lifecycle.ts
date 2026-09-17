import type {
  BuildUnit,
  Hooks,
  InstalledComponent,
  ManagedComponent,
} from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type {
  HealthCheck,
  ProcessObservation,
  Supervisor,
} from "../providers/contracts";
import { RigError, failureCauses, retainFailureCauses } from "../domain/errors";
import { randomUUID } from "node:crypto";

export interface TargetEffectCheckpoint {
  readonly targetId: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
/** One effect checkpoint found without a live Target during pruning. */
export interface PrunedCheckpoint {
  path: string;
  /** Known when the journal or claim could be read. */
  targetId?: string;
  outcome: "removed" | "retained";
  /** Why a checkpoint was kept: only a pending journal that recorded a change is retained. */
  reason?: string;
}
export interface TargetEffects {
  /** Remove effect checkpoints and preparation claims whose Target id is not in `live`.
   * A pending journal that recorded a change is retained, since only rollback may undo it. */
  pruneCheckpoints(live: ReadonlySet<string>): Promise<PrunedCheckpoint[]>;
  checkpoint(
    target: TargetRecord,
    previous?: TargetRecord,
  ): Promise<TargetEffectCheckpoint>;
  restoreEffects(target: TargetRecord): Promise<void>;
  commitEffects(target: TargetRecord): Promise<void>;
  retireSuperseded(
    previous: TargetRecord,
    candidate: TargetRecord,
  ): Promise<void>;
  retireArtifacts(target: TargetRecord): Promise<void>;
  supervisor(target: TargetRecord): Supervisor;
  prepare(target: TargetRecord): Promise<void>;
  environment(
    target: TargetRecord,
    component: ManagedComponent | InstalledComponent,
  ): Promise<Record<string, string>>;
  /** Runs one hook command for the Project (no component) or a Component; name identifies the hook in failures. */
  hook(
    command: string,
    target: TargetRecord,
    component: ManagedComponent | undefined,
    name: keyof Hooks,
  ): Promise<void>;
  /** May block or ignore cancellation. A not-ready result retries after 100ms and its reason is kept for the failure; rejection fails startup. */
  health(
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<HealthCheck>;
  /** Runs one build command in the Target workspace within the unit's budget, in its Component's environment scope
   * (the Project scope for the shared unit). Fails BUILD_FAILED or BUILD_TIMEOUT; a build past its budget has been killed. */
  build(unit: BuildUnit, target: TargetRecord): Promise<void>;
  /** Publishes a Tool's executable; never builds. */
  install(
    component: InstalledComponent,
    target: TargetRecord,
  ): Promise<{ outcome: "installed" | "unchanged" }>;
  route(target: TargetRecord): Promise<void>;
  removeRoute(target: TargetRecord): Promise<void>;
}
/** Where build outcomes are kept. `started` must be durable before it returns: it is the only evidence a crashed build leaves. */
export interface BuildJournal {
  started(unit: BuildUnit): Promise<void>;
  finished(unit: BuildUnit, state: "succeeded" | "failed"): Promise<void>;
}
/** The runtime's say over each process start, and what it learns before a route is published.
 * `starting` is asked before a stopped Service is spawned and answers with the incarnation its process will carry; when it
 * rejects, nothing is spawned. `activated` is told once that process is verified ready (alive, when it has no check) and before
 * the Target's route is published; when it rejects, the start fails like a failed readiness check. */
export interface ActivationJournal {
  starting(service: string): Promise<string>;
  activated(service: string, incarnation: string): Promise<void>;
}
export interface PreparationRequest {
  /** `all` runs every unit. `stopped` is a Working copy up: the units of Services that are not running and of every Tool,
   * after the shared unit when any Service is to start or any Tool exists; nothing when every Service runs and there is no Tool. */
  select: "all" | "stopped";
  journal: BuildJournal;
}
export interface TargetLifecycle {
  pruneCheckpoints(live: ReadonlySet<string>): Promise<PrunedCheckpoint[]>;
  checkpoint(
    target: TargetRecord,
    previous?: TargetRecord,
  ): Promise<TargetEffectCheckpoint>;
  restoreEffects(target: TargetRecord): Promise<void>;
  commitEffects(target: TargetRecord): Promise<void>;
  retireSuperseded(
    previous: TargetRecord,
    candidate: TargetRecord,
  ): Promise<void>;
  /** Installs the workspace's dependencies, then runs the selected build units in plan order, journaling each before and after.
   * Starts no Service and publishes nothing. The first failing unit stops preparation with BUILD_FAILED or BUILD_TIMEOUT.
   * BUILD_UNKNOWN means a command succeeded but its outcome could not be recorded; the journal still says `started`. */
  prepare(
    target: TargetRecord,
    request: PreparationRequest,
  ): Promise<{ built: string[] }>;
  /** Starts the recorded plan and publishes its Tools; never builds. A deployed Target whose recorded preparation is not
   * complete is refused with PREPARATION_INCOMPLETE, or BUILD_UNKNOWN when a unit's outcome is unknown.
   * Every stopped Service is started, whatever its restart policy: this is the explicit start. Without a journal each start
   * carries a fresh incarnation nobody records. */
  up(
    target: TargetRecord,
    checkpoint?: TargetEffectCheckpoint,
    journal?: ActivationJournal,
  ): Promise<{ outcome: "started" | "unchanged" }>;
  /** Starts one stopped Service of a running Target again under the same rules as `up`: fresh environment, readiness, then the
   * route. Never builds, installs or starts another Service. SERVICE_DEPENDENCY when a Service it depends on is not running;
   * a process started by a failed attempt has been stopped. START_UNVERIFIED when the start was journalled and then neither
   * this rollback stopped its process nor its exit was observed (the supervisor failed the start, or the process was gone). */
  recover(
    target: TargetRecord,
    service: string,
    journal: ActivationJournal,
  ): Promise<{ outcome: "started" | "unchanged" }>;
  down(target: TargetRecord): Promise<{ outcome: "stopped" | "unchanged" }>;
  /** Stop, unroute, and uninstall a Target under one checkpoint.
   * Fails with RETIRE_COMMIT_PENDING (retirement done, finalization unfinished)
   * or RETIRE_ROLLBACK (rollback itself failed) when effects are left changed;
   * any other failure has rolled back or never started, leaving the Target intact. */
  retire(
    target: TargetRecord,
    publishRemoval?: () => Promise<void>,
  ): Promise<void>;
}
export interface ReadinessTiming {
  /** Schedule once after delayMs; never inline. Return an idempotent cancellation.
   * Callbacks and cancellation must not throw. Elapsed callbacks run in deadline order.
   */
  schedule(delayMs: number, fire: () => void): () => void;
  /** How long a component without a health check must stay alive before up counts it as started; default 500 ms. */
  readonly startGraceMs?: number;
}

/** Production scheduling effect owner; lifecycle callers may substitute controlled time. */
const readinessTiming: ReadinessTiming = {
  schedule(delayMs, fire) {
    const timer = setTimeout(fire, delayMs);
    return () => clearTimeout(timer);
  },
};
const DEFAULT_START_GRACE_MS = 500;
/** Cadence for health retries and for confirming the supervised process is still alive. */
const OBSERVATION_INTERVAL_MS = 100;

/** Observes every managed Component before anything starts; an unknown owner aborts before hooks or installs run. */
async function observeManaged(
  target: TargetRecord,
  supervisor: Supervisor,
  only?: string[],
): Promise<Map<string, ProcessObservation>> {
  const observations = new Map<string, ProcessObservation>();
  for (const component of target.plan.components) {
    if (component.kind !== "managed") continue;
    if (only && !only.includes(component.name)) continue;
    const observation = await supervisor.observe(
      `${target.id}:${component.name}`,
    );
    if (observation.state === "unknown")
      throw new RigError(
        "PROCESS_UNKNOWN",
        `Cannot safely start ${component.name}.`,
        "Run rig doctor to inspect process ownership.",
      );
    observations.set(`${target.id}:${component.name}`, observation);
  }
  return observations;
}

/** Applies an already recorded plan. Changing config cannot change lifecycle identity or policy. */
export function createTargetLifecycle(
  effects: TargetEffects,
  timing: ReadinessTiming = readinessTiming,
): TargetLifecycle {
  const lifecycle: TargetLifecycle = {
    pruneCheckpoints: (live) => effects.pruneCheckpoints(live),
    async checkpoint(target, previous) {
      assertProviderProfile(target);
      return await effects.checkpoint(target, previous);
    },
    async restoreEffects(target) {
      assertProviderProfile(target);
      await effects.restoreEffects(target);
    },
    async commitEffects(target) {
      assertProviderProfile(target);
      await effects.commitEffects(target);
    },
    async retireSuperseded(previous, candidate) {
      assertProviderProfile(previous);
      assertProviderProfile(candidate);
      await effects.retireSuperseded(previous, candidate);
    },
    async retire(target, publishRemoval) {
      assertProviderProfile(target);
      const checkpoint = await effects.checkpoint(target);
      let finalizationPending = false;
      try {
        await stopForTransition(target, lifecycle);
        await effects.removeRoute(target);
        await effects.retireArtifacts(target);
        await publishRemoval?.();
        finalizationPending = true;
        await checkpoint.commit();
      } catch (error) {
        if (finalizationPending)
          throw new RigError(
            "RETIRE_COMMIT_PENDING",
            publishRemoval
              ? "The Target inventory was removed but checkpoint finalization failed."
              : "The Target inventory is retained, but retirement checkpoint finalization failed.",
            publishRemoval
              ? "Preserve its effect checkpoint; the retired Target must not be restarted."
              : "Preserve its effect checkpoint and retry the operation; the Target must not be restarted.",
            {},
            failureCauses(error),
          );
        try {
          await checkpoint.rollback();
          if (target.desired === "running") await lifecycle.up(target);
        } catch (recovery) {
          throw new RigError(
            "RETIRE_ROLLBACK",
            "Target retirement failed and its saved effects could not be restored.",
            "Run down for this Target and inspect its effect checkpoint.",
            {},
            failureCauses(error, recovery),
          );
        }
        throw error;
      }
    },
    async prepare(target, { select, journal }) {
      assertProviderProfile(target);
      await effects.prepare(target);
      const units = await selectUnits(target, select, effects);
      for (const unit of units) {
        await journal.started(unit);
        try {
          await effects.build(unit, target);
        } catch (error) {
          try {
            await journal.finished(unit, "failed");
          } catch (recordError) {
            throw retainFailureCauses(error, error, recordError);
          }
          throw error;
        }
        try {
          await journal.finished(unit, "succeeded");
        } catch (error) {
          throw new RigError(
            "BUILD_UNKNOWN",
            `The ${unitLabel(unit)} finished, but its outcome could not be recorded.`,
            forceHint(target),
            { unit: unit.id },
            failureCauses(error),
          );
        }
      }
      return { built: units.map((unit) => unit.id) };
    },
    async up(target, providedCheckpoint, journal) {
      assertProviderProfile(target);
      assertPrepared(target);
      if (providedCheckpoint && providedCheckpoint.targetId !== target.id)
        throw new RigError(
          "EFFECTS_SCOPE",
          "The effect checkpoint belongs to another Target.",
          "Use the checkpoint for the selected Target.",
        );
      const supervisor = effects.supervisor(target);
      const checkpoint =
        providedCheckpoint ?? (await effects.checkpoint(target));
      const started: string[] = [];
      let installed = false;
      let began = false;
      try {
        await effects.prepare(target);
        const observations = await observeManaged(target, supervisor);
        began = [...observations.values()].some((o) => o.state === "stopped");
        if (began && target.plan.hooks?.preStart)
          await effects.hook(
            target.plan.hooks.preStart,
            target,
            undefined,
            "preStart",
          );
        // Dependencies are ordered during plan resolution, before any process starts.
        for (const component of target.plan.components) {
          if (component.kind === "persistent") continue;
          if (component.kind === "installed") {
            const result = await effects.install(component, target);
            installed = result.outcome === "installed" || installed;
            continue;
          }
          const key = `${target.id}:${component.name}`;
          if (observations.get(key)!.state === "running") {
            // A dependency that is already running must still be ready before a dependent starts against it.
            if (component.health && hasDependents(target, component.name))
              await awaitReady(component, target, effects, timing, {
                observe: () => supervisor.observe(key),
              });
            continue;
          }
          await startService(target, component, supervisor, journal, started);
        }
        await effects.route(target);
        if (began && target.plan.hooks?.postStart)
          await effects.hook(
            target.plan.hooks.postStart,
            target,
            undefined,
            "postStart",
          );
        if (!providedCheckpoint) await checkpoint.commit();
        return {
          outcome: started.length || installed ? "started" : "unchanged",
        };
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const key of started.reverse())
          try {
            await supervisor.stop(key);
          } catch (failure) {
            rollbackErrors.push(failure);
          }
        if (!providedCheckpoint && !rollbackErrors.length)
          try {
            await checkpoint.rollback();
          } catch (failure) {
            rollbackErrors.push(failure);
          }
        if (rollbackErrors.length)
          throw new RigError(
            "START_ROLLBACK_FAILED",
            "Startup failed and process or executable rollback could not be verified.",
            "Run rig doctor and rig down before retrying.",
            { cause: error, rollbackErrors },
          );
        throw error;
      }
    },
    async recover(target, service, journal) {
      assertProviderProfile(target);
      assertPrepared(target);
      const component = target.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === service,
      );
      if (!component)
        throw new RigError(
          "SERVICE_UNKNOWN",
          `${target.name} has no Service named '${service}'.`,
          "Select a Service of the recorded plan.",
          { service },
        );
      const supervisor = effects.supervisor(target);
      // Only what this start depends on decides it; a sibling that cannot be observed is not its concern.
      const observations = await observeManaged(target, supervisor, [
        service,
        ...component.dependsOn,
      ]);
      if (observations.get(`${target.id}:${service}`)!.state === "running")
        return { outcome: "unchanged" };
      const missing = component.dependsOn.find(
        (name) => observations.get(`${target.id}:${name}`)?.state !== "running",
      );
      if (missing)
        throw new RigError(
          "SERVICE_DEPENDENCY",
          `${service} depends on ${missing}, which is not running.`,
          `Run rig up ${target.name} to start both.`,
          { service, dependency: missing },
        );
      const started: string[] = [];
      let journalled = false;
      const tracked: ActivationJournal = {
        async starting(name) {
          const incarnation = await journal.starting(name);
          journalled = true;
          return incarnation;
        },
        activated: (name, incarnation) => journal.activated(name, incarnation),
      };
      try {
        await effects.prepare(target);
        await startService(target, component, supervisor, tracked, started);
        await effects.route(target);
        return { outcome: started.length ? "started" : "unchanged" };
      } catch (error) {
        let stopped = started.length > 0;
        for (const key of started)
          try {
            if ((await supervisor.stop(key)).outcome !== "stopped")
              stopped = false;
          } catch (failure) {
            throw new RigError(
              "START_ROLLBACK_FAILED",
              "The Service could not be started again and its new process could not be verified stopped.",
              "Run rig doctor and rig down before retrying.",
              {},
              failureCauses(error, failure),
            );
          }
        // Refused before anything was asked of the supervisor, a process this rollback stopped itself, and an exit that
        // carries its own observation each say how the attempt ended. Anything else after the start was journalled (the
        // supervisor failed the start, or the process was already gone) leaves a process whose end nobody witnessed.
        if (
          !journalled ||
          stopped ||
          (error instanceof RigError && error.code === "PROCESS_EXITED")
        )
          throw error;
        throw new RigError(
          "START_UNVERIFIED",
          `${service} was asked to start, but how that start ended could not be established.`,
          `Inspect Target logs, then run rig up ${target.name} to start it again.`,
          { service },
          failureCauses(error),
        );
      }
    },
    async down(target) {
      assertProviderProfile(target);
      const supervisor = effects.supervisor(target);
      let changed = false;
      const hookFailures: unknown[] = [],
        processFailures: unknown[] = [];
      const attempt = async (work: () => Promise<void>, process = false) => {
        try {
          await work();
        } catch (error) {
          (process ? processFailures : hookFailures).push(error);
        }
      };
      let began = false;
      for (const component of [...target.plan.components].reverse()) {
        if (component.kind !== "managed") continue;
        let needsPreStop = true;
        try {
          const observation = await supervisor.observe(
            `${target.id}:${component.name}`,
          );
          needsPreStop = observation.state !== "stopped";
        } catch {
          // Failed observation is not proof of absence; stop still verifies shutdown.
        }
        if (needsPreStop && !began) {
          began = true;
          if (target.plan.hooks?.preStop)
            await attempt(() =>
              effects.hook(
                target.plan.hooks!.preStop!,
                target,
                undefined,
                "preStop",
              ),
            );
        }
        if (needsPreStop && component.hooks?.preStop)
          await attempt(() =>
            effects.hook(
              component.hooks!.preStop!,
              target,
              component,
              "preStop",
            ),
          );
        let stopped = false;
        await attempt(async () => {
          const result = await supervisor.stop(
            `${target.id}:${component.name}`,
          );
          stopped = result.outcome === "stopped";
          changed = stopped || changed;
        }, true);
        if (component.hooks?.postStop && stopped)
          await attempt(() =>
            effects.hook(
              component.hooks!.postStop!,
              target,
              component,
              "postStop",
            ),
          );
      }
      if (changed && target.plan.hooks?.postStop)
        await attempt(() =>
          effects.hook(
            target.plan.hooks!.postStop!,
            target,
            undefined,
            "postStop",
          ),
        );
      if (processFailures.length)
        throw new RigError(
          "STOP_INCOMPLETE",
          "One or more managed processes could not be stopped.",
          "All managed Components were attempted. Inspect Target logs and status before retrying.",
          { processFailures, hookFailures },
        );
      if (hookFailures.length)
        throw new RigError(
          "STOP_HOOKS",
          "Managed processes are stopped, but shutdown hooks failed.",
          "Inspect Target logs and correct the shutdown hooks.",
          {
            processesStopped: true,
            outcome: changed ? "stopped" : "unchanged",
            hookFailures,
          },
        );
      return { outcome: changed ? "stopped" : "unchanged" };
    },
  };
  /** One Service start: hook, approval, spawn with a fresh environment, readiness, report, hook. `started` gains the process key
   * as soon as a process was spawned, so the caller can stop it when a later step fails. */
  async function startService(
    target: TargetRecord,
    component: ManagedComponent,
    supervisor: Supervisor,
    journal: ActivationJournal | undefined,
    started: string[],
  ): Promise<void> {
    const key = `${target.id}:${component.name}`;
    if (component.hooks?.preStart)
      await effects.hook(
        component.hooks.preStart,
        target,
        component,
        "preStart",
      );
    // Read before the start is journalled, so an unreadable env file leaves no record of a start that never was.
    const env = await effects.environment(target, component);
    const incarnation = journal
      ? await journal.starting(component.name)
      : randomUUID();
    const result = await supervisor.ensureRunning({
      key,
      componentName: component.name,
      command: ["/bin/sh", "-c", component.command],
      cwd: target.plan.workspacePath,
      env,
      logRoot: target.logRoot,
      incarnation,
    });
    if (result.outcome === "started") started.push(key);
    const process = { observe: () => supervisor.observe(key) };
    if (component.health)
      await awaitReady(component, target, effects, timing, process);
    else await awaitSurvival(component, timing, process);
    await journal?.activated(component.name, incarnation);
    if (component.hooks?.postStart && result.outcome === "started")
      await effects.hook(
        component.hooks.postStart,
        target,
        component,
        "postStart",
      );
  }
  return lifecycle;
}
/** The units one preparation runs, in plan order. */
async function selectUnits(
  target: TargetRecord,
  select: PreparationRequest["select"],
  effects: Pick<TargetEffects, "supervisor">,
): Promise<BuildUnit[]> {
  const units = target.plan.builds ?? [];
  if (select === "all") return units;
  const observations = await observeManaged(target, effects.supervisor(target));
  // The work an explicit Working copy up does: start each Service that is not running, and publish every Tool.
  const work = new Set(
    target.plan.components
      .filter(
        (component) =>
          component.kind === "installed" ||
          (component.kind === "managed" &&
            observations.get(`${target.id}:${component.name}`)?.state !==
              "running"),
      )
      .map((component) => component.name),
  );
  if (!work.size) return [];
  return units.filter(
    (unit) => unit.component === undefined || work.has(unit.component),
  );
}
function unitLabel(unit: Pick<BuildUnit, "component">): string {
  return unit.component === undefined
    ? "shared build"
    : `${unit.component} build`;
}
/** Only a forced deployment gives an incomplete or uncertain preparation a fresh scope. */
function forceHint(target: Pick<TargetRecord, "kind" | "name">): string {
  if (target.kind === "local")
    return "Run rig restart for the Working copy to build it again.";
  const selector =
    target.kind === "preview"
      ? `preview --deployment ${target.name}`
      : target.name;
  return `Run rig deploy ${selector} --force to build a fresh Deployment; rig never reruns a build whose outcome it does not know.`;
}
/** The outcomes recorded for the Target's current workspace; another workspace's outcomes prove nothing here. */
function recordedUnits(
  target: Pick<TargetRecord, "preparation" | "plan">,
): NonNullable<TargetRecord["preparation"]>["units"] {
  return target.preparation?.deployment === target.plan.workspacePath
    ? target.preparation.units
    : {};
}
/** The unit of the recorded plan that was started and never recorded as finished, if any. */
export function unknownUnit(target: TargetRecord): BuildUnit | undefined {
  const recorded = recordedUnits(target);
  return (target.plan.builds ?? []).find(
    (unit) => recorded[unit.id]?.state === "started",
  );
}
/** Rejects BUILD_UNKNOWN when a unit of the recorded plan was started and never recorded as finished. */
export function assertBuildsKnown(target: TargetRecord): void {
  const unit = unknownUnit(target);
  if (unit)
    throw new RigError(
      "BUILD_UNKNOWN",
      `Whether the ${unitLabel(unit)} of ${target.name} finished is unknown.`,
      forceHint(target),
      { unit: unit.id },
    );
}
/** Rejects BUILD_UNKNOWN when deploying `source` without force would repeat an attempt, recorded or rolled back, that left a build's outcome unknown. */
export function assertSourceBuildsKnown(
  target: TargetRecord,
  source: { branch?: string; commit?: string },
): void {
  if (target.commit === source.commit && target.branch === source.branch)
    assertBuildsKnown(target);
  const attempt = target.uncertainBuild;
  if (
    attempt &&
    attempt.commit === source.commit &&
    attempt.branch === source.branch
  )
    throw new RigError(
      "BUILD_UNKNOWN",
      `Whether build unit ${attempt.unit} finished in the last deployment attempt of this Commit to ${target.name} is unknown.`,
      forceHint(target),
      { unit: attempt.unit },
    );
}
/** What a record restored over `attempt` keeps of it: the attempted source, when one of its builds has an unknown outcome. */
export function uncertainAttempt(
  attempt: TargetRecord,
): TargetRecord["uncertainBuild"] {
  const unit = unknownUnit(attempt);
  return unit
    ? {
        ...(attempt.branch ? { branch: attempt.branch } : {}),
        ...(attempt.commit ? { commit: attempt.commit } : {}),
        unit: unit.id,
      }
    : undefined;
}
/** A deployed Target starts only from a preparation whose every unit is recorded as succeeded for this workspace. */
function assertPrepared(target: TargetRecord): void {
  if (target.kind === "local") return;
  assertBuildsKnown(target);
  const recorded = recordedUnits(target);
  for (const unit of target.plan.builds ?? []) {
    const state = recorded[unit.id]?.state;
    if (state === "succeeded") continue;
    throw new RigError(
      "PREPARATION_INCOMPLETE",
      state === "failed"
        ? `The ${unitLabel(unit)} of ${target.name} failed, so this Deployment was never prepared.`
        : `The ${unitLabel(unit)} of ${target.name} never ran, so this Deployment was never prepared.`,
      forceHint(target),
      { unit: unit.id },
    );
  }
}
/** The supervised process behind one component; readiness only counts while it is alive. */
interface SupervisedProcess {
  observe(): Promise<ProcessObservation>;
}
/** Health passes only while rig's own process is running: a foreign listener on the port never certifies a dead
 * component, and a process that exits fails fast with its exit code instead of waiting for readyTimeout. */
async function awaitReady(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "health">,
  timing: ReadinessTiming,
  process: SupervisedProcess,
): Promise<void> {
  const controller = new AbortController();
  let cancelDeadline = () => {};
  let cancelRetry = () => {};
  // Expiry settles independently of provider cooperation.
  const expired = new Promise<false>((resolve) => {
    cancelDeadline = timing.schedule(component.readyTimeout * 1000, () => {
      resolve(false);
      controller.abort();
    });
  });
  let lastCheck: string | undefined;
  try {
    while (!controller.signal.aborted) {
      await assertAlive(component, process);
      const check = await Promise.race([
        effects.health(component, target, controller.signal),
        expired,
      ]);
      if (controller.signal.aborted || check === false) break;
      if (check.ready) {
        await assertAlive(component, process);
        return;
      }
      lastCheck = check.reason;
      await Promise.race([
        new Promise<void>((resolve) => {
          cancelRetry = timing.schedule(OBSERVATION_INTERVAL_MS, resolve);
        }),
        expired,
      ]);
    }
  } finally {
    cancelDeadline();
    cancelRetry();
  }
  throw new RigError(
    "HEALTH_FAILED",
    lastCheck === undefined
      ? `${component.name} did not become ready.`
      : `${component.name} did not become ready (last check: ${lastCheck}).`,
    "Inspect Target logs and the configured health check.",
    {
      component: component.name,
      ...(lastCheck === undefined ? {} : { lastCheck }),
    },
  );
}
/** Whether another Component in the plan lists `name` in dependsOn. */
function hasDependents(target: TargetRecord, name: string): boolean {
  return target.plan.components.some(
    (component) =>
      component.kind === "managed" && component.dependsOn.includes(name),
  );
}
/** Without a health check, a component counts as started only once it has outlived the start grace period. */
async function awaitSurvival(
  component: ManagedComponent,
  timing: ReadinessTiming,
  process: SupervisedProcess,
): Promise<void> {
  const grace = timing.startGraceMs ?? DEFAULT_START_GRACE_MS;
  const cancels: (() => void)[] = [];
  const checks: Promise<void>[] = [];
  // Every observation is scheduled up front so a crash-and-restart loop cannot hide between polls.
  for (const at of observationTimes(grace))
    checks.push(
      new Promise<void>((resolve) => {
        cancels.push(timing.schedule(at, resolve));
      }).then(() => assertAlive(component, process)),
    );
  try {
    await Promise.all(checks);
  } finally {
    for (const cancel of cancels) cancel();
  }
}
/** Poll instants within the grace period at the observation cadence, always ending at the grace itself. */
function observationTimes(graceMs: number): number[] {
  const times: number[] = [];
  for (
    let at = OBSERVATION_INTERVAL_MS;
    at < graceMs;
    at += OBSERVATION_INTERVAL_MS
  )
    times.push(at);
  if (graceMs > 0) times.push(graceMs);
  return times;
}
async function assertAlive(
  component: ManagedComponent,
  process: SupervisedProcess,
): Promise<void> {
  const observation = await process.observe();
  if (observation.state !== "stopped") return;
  const exitCode = observation.exitCode;
  // The shell's own exit codes: 127 names a command it could not find, 126 one it could not run.
  const shellFailure =
    exitCode === 127
      ? "the shell found no executable for its command"
      : exitCode === 126
        ? "the shell could not run its command (not executable)"
        : undefined;
  throw new RigError(
    "PROCESS_EXITED",
    exitCode === undefined
      ? `${component.name} exited before it became ready.`
      : `${component.name} exited with code ${exitCode} before it became ready${shellFailure ? `: ${shellFailure}` : ""}.`,
    shellFailure
      ? "Install the missing tool where rigd can find it (rigd uses the PATH it was installed from), or fix the command, then retry."
      : "Inspect Target logs for the start-up failure before retrying.",
    {
      component: component.name,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(observation.signal === undefined
        ? {}
        : { signal: observation.signal }),
    },
  );
}

export async function stopForTransition(
  target: TargetRecord,
  lifecycle: Pick<TargetLifecycle, "down">,
): Promise<void> {
  try {
    await lifecycle.down(target);
  } catch (error) {
    if (!(error instanceof RigError) || error.code !== "STOP_HOOKS")
      throw error;
  }
}
function assertProviderProfile(target: TargetRecord): void {
  if (target.plan.providerProfile !== "default")
    throw new RigError(
      "PROVIDER_PROFILE_UNSUPPORTED",
      "The recorded Target uses an unsupported provider profile.",
      "Reconcile its historical provider state explicitly before running real adapters.",
      { profile: target.plan.providerProfile },
    );
}
