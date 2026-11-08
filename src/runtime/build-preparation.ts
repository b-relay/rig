import type { BuildUnit } from "../config/types";
import type { PreparedEnvironment, TargetRecord } from "../domain/runtime";
import { withoutReferenceVariables } from "../domain/process-environment";
import { rigCommand } from "../domain/rig-command";
import {
  RigError,
  diagnosticErrorCode,
  failureCauses,
  retainFailureCauses,
} from "../domain/errors";
import { serviceGraceMs } from "../domain/stop-budget";
import type { StopResult } from "../providers/contracts";
import type {
  PreparationRequest,
  StopControl,
  TargetEffects,
  TargetLifecycle,
} from "./lifecycle";
import { managedComponent, observeManaged } from "./plan-services";
import { forceHint, unitLabel } from "./preparation-evidence";

/** A Target's preparation: its workspace, its build units and the evidence they leave, the build process a daemon that
 * died left behind, and the checks a deploy makes of what a build or start would compose before anything stops. */
export type BuildPreparation = Pick<
  TargetLifecycle,
  | "prepare"
  | "observePreparation"
  | "stopPreparation"
  | "environmentDigest"
  | "checkFirstBuild"
  | "checkEnvironmentValues"
>;

/** The supervisor key a Target's build and dependency installation commands are recorded under, one at a time. A Service
 * name never holds ':', so it never collides with a Service's, nor with a job's. */
export function preparationProcessKey(
  target: Pick<TargetRecord, "id">,
): string {
  return `${target.id}:preparation:run`;
}
export function createBuildPreparation(
  effects: TargetEffects,
): BuildPreparation {
  /** The keyed digests of `env`, a composed environment of `target` a preparation runs a command in: as it is, and without
   * its `_RIG_` variables when it has any. Empty when it was not composed or no digest can be taken. */
  async function digestsOf(
    target: TargetRecord,
    env: Readonly<Record<string, string>> | undefined,
  ): Promise<PreparedEnvironment> {
    const digest = (composed: Readonly<Record<string, string>>) =>
      effects.digestEnvironment?.(target, composed).catch(() => undefined);
    if (env === undefined) return {};
    const environment = await digest(env);
    if (environment === undefined) return {};
    const written = withoutReferenceVariables(env);
    const writtenEnvironment =
      Object.keys(written).length < Object.keys(env).length
        ? await digest(written)
        : undefined;
    return {
      environment,
      ...(writtenEnvironment !== undefined ? { writtenEnvironment } : {}),
    };
  }
  /** Stops the build a daemon that died left running for `target`, within the default stop grace (a build has no
   * stop_timeout) or less under a kill; `unchanged` when none runs. */
  async function stopPreparation(
    target: TargetRecord,
    stops: StopControl = {},
  ): Promise<StopResult> {
    const supervisor = effects.supervisor(target),
      key = preparationProcessKey(target);
    if ((await supervisor.observe(key)).state === "stopped")
      return { outcome: "unchanged" };
    const kill = stops.kill?.(target);
    return await supervisor.stop(key, {
      graceMs: serviceGraceMs(undefined),
      ...(kill ? { kill } : {}),
      ...(stops.detach ? { detach: stops.detach } : {}),
    });
  }
  return {
    async prepare(target, { select, journal }) {
      // Each environment is composed once and handed to the command it is for, so what is digested is what ran, even when
      // an env file changes meanwhile. One that cannot be composed here is composed by the command itself, which fails as
      // it always did; nothing is digested for it.
      const install = await effects.environment(target).catch(() => undefined);
      await stopPreparation(target);
      await effects.prepare(target, install);
      const installed = await digestsOf(target, install);
      const units = await selectUnits(target, select, effects);
      for (const unit of units) {
        const env = await effects
          .buildEnvironment?.(unit, target)
          .catch(() => undefined);
        // Best effort: a build never fails for its digest, and a unit recorded without one keeps no Service running.
        await journal.started(unit, await digestsOf(target, env));
        try {
          await effects.build(unit, target, env);
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
      return { built: units.map((unit) => unit.id), ...installed };
    },
    observePreparation: (target, signal) =>
      effects.supervisor(target).observe(preparationProcessKey(target), signal),
    stopPreparation: (target, stops) => stopPreparation(target, stops),
    async environmentDigest(target, service) {
      const component =
        service === undefined ? undefined : managedComponent(target, service);
      if (!effects.digestEnvironment)
        throw new RigError(
          "ENV_DIGEST",
          "This rigd cannot take a digest of a Service's environment.",
          `Run ${rigCommand("restart", { target })} to start every Service again.`,
          service === undefined ? {} : { service },
        );
      return await effects.digestEnvironment(
        target,
        await effects.environment(target, component),
      );
    },
    async checkFirstBuild(target) {
      const first = target.plan.builds?.[0];
      if (!first) return;
      await effects.buildEnvironment?.(first, target);
      await effects.buildDirectory?.(first, target);
    },
    async checkEnvironmentValues(target) {
      await effects.checkEnvironmentValues?.(target);
    },
  };
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
/** Fails as composing a Service's environment fails (an env file refused for any reason), so a start that could not happen
 * is refused before anything stops. Starts nothing, and needs every build that may write such a file to have run. */
export async function assertServiceEnvironments(
  target: TargetRecord,
  lifecycle: Pick<TargetLifecycle, "environmentDigest">,
): Promise<void> {
  for (const component of target.plan.components)
    if (component.kind === "managed")
      await lifecycle
        .environmentDigest(target, component.name)
        .catch((error: unknown) => {
          // A start never fails for its digest, only for its environment.
          if (diagnosticErrorCode(error) !== "ENV_DIGEST") throw error;
        });
}
