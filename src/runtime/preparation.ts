import { createHash } from "node:crypto";
import type { BuildUnit, TargetPlan } from "../config/types";
import type { BuildOutcome, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import type { BuildJournal, PreparationRequest } from "./lifecycle";
import { persistTarget } from "./targets";

/** Digest of what a unit's build was declared to be: its command, budget, public env, env-file paths and workspace.
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
  if (target.preparation?.deployment !== target.plan.workspacePath)
    target.preparation = { deployment: target.plan.workspacePath, units: {} };
  const units = target.preparation.units;
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
    started: (unit) =>
      save(unit, {
        state: "started",
        policy: unitPolicy(unit, target.plan),
        ...(target.commit ? { commit: target.commit } : {}),
        startedAt: deps.now(),
      }),
    finished: (unit, state) =>
      save(unit, { ...units[unit.id]!, state, finishedAt: deps.now() }),
  };
  return await deps.lifecycle.prepare(target, { select, journal });
}
