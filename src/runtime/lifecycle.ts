import type {
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
import { RigError, failureCauses } from "../domain/errors";

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
  install(
    component: InstalledComponent,
    target: TargetRecord,
  ): Promise<{ outcome: "installed" | "unchanged" }>;
  route(target: TargetRecord): Promise<void>;
  removeRoute(target: TargetRecord): Promise<void>;
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
  up(
    target: TargetRecord,
    checkpoint?: TargetEffectCheckpoint,
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
): Promise<Map<string, ProcessObservation>> {
  const observations = new Map<string, ProcessObservation>();
  for (const component of target.plan.components) {
    if (component.kind !== "managed") continue;
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
    async up(target, providedCheckpoint) {
      assertProviderProfile(target);
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
          if (component.hooks?.preStart)
            await effects.hook(
              component.hooks.preStart,
              target,
              component,
              "preStart",
            );
          const result = await supervisor.ensureRunning({
            key,
            componentName: component.name,
            command: ["/bin/sh", "-c", component.command],
            cwd: target.plan.workspacePath,
            env: await effects.environment(target, component),
            logRoot: target.logRoot,
            keepAlive: target.plan.daemon?.keepAlive ?? true,
          });
          if (result.outcome === "started") started.push(key);
          const process = { observe: () => supervisor.observe(key) };
          if (component.health)
            await awaitReady(component, target, effects, timing, process);
          else await awaitSurvival(component, timing, process);
          if (component.hooks?.postStart && result.outcome === "started")
            await effects.hook(
              component.hooks.postStart,
              target,
              component,
              "postStart",
            );
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
          needsPreStop =
            observation.state !== "stopped" ||
            observation.restartPending === true;
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
  return lifecycle;
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
      ...(observation.restartPending ? { restartPending: true } : {}),
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
