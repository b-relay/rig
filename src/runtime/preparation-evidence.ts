import type { BuildUnit } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import { RigError } from "../domain/errors";
import { rigCommand } from "../domain/rig-command";

// What a Target's recorded build outcomes allow: a deployed Target starts only from a complete preparation, and no build
// whose outcome is unknown is run again without force. Pure: every function here reads only the record it is given.

/** How a failure names `unit`: the shared build, or its Component's. */
export function unitLabel(unit: Pick<BuildUnit, "component">): string {
  return unit.component === undefined
    ? "shared build"
    : `${unit.component} build`;
}
/** Only a forced deployment gives an incomplete or uncertain preparation a fresh scope. */
export function forceHint(
  target: Pick<TargetRecord, "kind" | "name" | "branch" | "plan">,
): string {
  if (target.kind === "working")
    return `Run ${rigCommand("restart", { target })} to build it again.`;
  return `Run ${rigCommand("deploy", { target }, "--force")} to build a fresh Deployment; rig never reruns a build whose outcome it does not know.`;
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
export function assertPrepared(target: TargetRecord): void {
  if (target.kind === "working") return;
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
