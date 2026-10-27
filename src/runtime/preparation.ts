import { createHash } from "node:crypto";
import type { BuildUnit, TargetPlan } from "../config/types";
import type {
  BuildOutcome,
  PreparedEnvironment,
  TargetRecord,
} from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import type { BuildJournal, PreparationRequest } from "./lifecycle";
import { persistTarget } from "./targets";

/** Digest of what a unit's build was declared to be: its command, budget, public env, env-file paths, workspace and working_dir.
 * Env-file values never enter it, so an operator's secret reaches no record and a changed value reruns nothing. */
export function unitPolicy(unit: BuildUnit, plan: TargetPlan): string {
  const scope =
    plan.components.find((component) => component.name === unit.component) ??
    plan;
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: unit.id,
        command: unit.command,
        timeout: unit.timeout,
        workspace: plan.workspacePath,
        // Only a Service that sets working_dir records one, so a unit planned before it existed keeps its policy.
        ...("workingDir" in scope && scope.workingDir !== undefined
          ? { workingDir: scope.workingDir }
          : {}),
        env: scope.env ?? {},
        envFiles: (scope.envFiles ?? []).map((file) => file.path),
      }),
    )
    .digest("hex");
}

/** Prepares `target` and keeps each unit's outcome on its record, saved before and after the unit's command.
 * Outcomes recorded for another workspace are dropped first: a new revision is a fresh scope.
 * `target` is updated in place; failures are those of TargetLifecycle.prepare, or of the store when `started` cannot be saved. */
export async function prepareTarget(
  target: TargetRecord,
  select: PreparationRequest["select"],
  deps: Pick<RuntimeDependencies, "lifecycle" | "store" | "now">,
): Promise<{ built: string[] }> {
  const fresh = target.preparation?.deployment !== target.plan.workspacePath;
  const preparation = (target.preparation = fresh
    ? { deployment: target.plan.workspacePath, units: {} }
    : target.preparation!);
  const units = preparation.units;
  const save = async (unit: BuildUnit, outcome: BuildOutcome) => {
    const before = units[unit.id];
    units[unit.id] = outcome;
    try {
      await persistTarget(target, deps.store);
    } catch (error) {
      // The record in memory never claims more than the one on disk.
      if (before) units[unit.id] = before;
      else delete units[unit.id];
      throw error;
    }
  };
  const journal: BuildJournal = {
    started: (unit, evidence) =>
      save(unit, {
        state: "started",
        policy: unitPolicy(unit, target.plan),
        ...(target.commit ? { commit: target.commit } : {}),
        ...preparedEnvironment(evidence),
        startedAt: deps.now(),
      }),
    finished: (unit, state) =>
      save(unit, { ...units[unit.id]!, state, finishedAt: deps.now() }),
  };
  const prepared = await deps.lifecycle.prepare(target, { select, journal });
  // The Project scope dependency installation ran in, as handed to it; a workspace installs once, at its first preparation.
  if (fresh) Object.assign(preparation, preparedEnvironment(prepared));
  return { built: prepared.built };
}
/** The environment digests `evidence` holds, and nothing else. */
function preparedEnvironment(
  evidence: PreparedEnvironment | undefined,
): PreparedEnvironment {
  return {
    ...(evidence?.environment !== undefined
      ? { environment: evidence.environment }
      : {}),
    ...(evidence?.writtenEnvironment !== undefined
      ? { writtenEnvironment: evidence.writtenEnvironment }
      : {}),
  };
}
