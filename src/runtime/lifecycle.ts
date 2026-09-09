import type { InstalledComponent, ManagedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type { Supervisor } from "../providers/contracts";
import { RigError } from "../domain/errors";

export interface TargetEffectCheckpoint {
  readonly targetId: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
export interface TargetEffects {
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
  hook(
    command: string,
    target: TargetRecord,
    component?: ManagedComponent | InstalledComponent,
  ): Promise<void>;
  health(
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<boolean>;
  install(
    component: InstalledComponent,
    target: TargetRecord,
  ): Promise<{ outcome: "installed" | "unchanged" }>;
  route(target: TargetRecord): Promise<void>;
  removeRoute(target: TargetRecord): Promise<void>;
}
export interface TargetLifecycle {
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
  retire(
    target: TargetRecord,
    publishRemoval?: () => Promise<void>,
  ): Promise<void>;
}
/** Applies an already recorded plan. Changing config cannot change lifecycle identity or policy. */
export function createTargetLifecycle(effects: TargetEffects): TargetLifecycle {
  const lifecycle: TargetLifecycle = {
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
      let removalPublished = false;
      try {
        await stopForTransition(target, lifecycle);
        await effects.removeRoute(target);
        await effects.retireArtifacts(target);
        await publishRemoval?.();
        removalPublished = true;
        await checkpoint.commit();
      } catch (error) {
        if (removalPublished)
          throw new RigError(
            "RETIRE_COMMIT_PENDING",
            "The Target inventory was removed but checkpoint finalization failed.",
            "Preserve its effect checkpoint; the retired Target must not be restarted.",
          );
        try {
          await checkpoint.rollback();
          if (target.desired === "running") await lifecycle.up(target);
        } catch {
          throw new RigError(
            "RETIRE_ROLLBACK",
            "Target retirement failed and its saved effects could not be restored.",
            "Run down for this Target and inspect its effect checkpoint.",
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
        // Dependencies are ordered during plan resolution, before any process starts.
        for (const component of target.plan.components) {
          if (component.kind === "persistent") continue;
          if (component.kind === "installed") {
            const result = await effects.install(component, target);
            installed = result.outcome === "installed" || installed;
            continue;
          }
          const key = `${target.id}:${component.name}`;
          const observation = await supervisor.observe(key);
          if (observation.state === "running") continue;
          if (observation.state === "unknown")
            throw new RigError(
              "PROCESS_UNKNOWN",
              `Cannot safely start ${component.name}.`,
              "Run rig doctor to inspect process ownership.",
            );
          if (!began) {
            began = true;
            if (target.plan.hooks?.preStart)
              await effects.hook(target.plan.hooks.preStart, target);
          }
          if (component.hooks?.preStart)
            await effects.hook(component.hooks.preStart, target, component);
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
          if (component.health) await awaitReady(component, target, effects);
          if (component.hooks?.postStart && result.outcome === "started")
            await effects.hook(component.hooks.postStart, target, component);
        }
        await effects.route(target);
        if (began && target.plan.hooks?.postStart)
          await effects.hook(target.plan.hooks.postStart, target);
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
            observation.state !== "stopped" || observation.restartPending === true;
        } catch {
          // Failed observation is not proof of absence; stop still verifies shutdown.
        }
        if (needsPreStop && !began) {
          began = true;
          if (target.plan.hooks?.preStop)
            await attempt(() => effects.hook(target.plan.hooks!.preStop!, target));
        }
        if (needsPreStop && component.hooks?.preStop)
          await attempt(() =>
            effects.hook(component.hooks!.preStop!, target, component),
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
            effects.hook(component.hooks!.postStop!, target, component),
          );
      }
      if (changed && target.plan.hooks?.postStop)
        await attempt(() => effects.hook(target.plan.hooks!.postStop!, target));
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
async function awaitReady(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "health">,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Aborting asks the provider to stop; settlement must not depend on it cooperating.
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
      controller.abort();
    }, component.readyTimeout * 1000);
  });
  try {
    while (!controller.signal.aborted) {
      const healthy = await Promise.race([
        effects.health(component, target, controller.signal),
        expired,
      ]);
      if (healthy) return;
      if (controller.signal.aborted) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  throw new RigError(
    "HEALTH_FAILED",
    `${component.name} did not become ready.`,
    "Inspect Target logs and the configured health check.",
    { component: component.name },
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
