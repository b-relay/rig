import type { TargetRecord } from "../domain/runtime";
import { RigError, failureCauses, retainFailureCauses } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import { persistTarget } from "./targets";
import { stopForTransition } from "./lifecycle";
/** Unresolved recovery must be rejected before accepting any deployment outcome. */
export function assertDeploymentRecovered(
  previous: Pick<TargetRecord, "recovery"> | undefined,
): void {
  if (previous?.recovery)
    throw new RigError(
      "DEPLOY_RECOVERY",
      "The previous deployment has an unresolved transition.",
      "Run down for this Target to finish stopping both plans before deploying again.",
    );
}
/** The saved recovery record owns both plans until candidate activation or verified rollback finishes. */
export async function activateDeployment(
  candidate: TargetRecord,
  previous: TargetRecord | undefined,
  intent: { activation: "start" | "prepare" },
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  assertDeploymentRecovered(previous);
  candidate.deploymentIncomplete = true;
  candidate.recovery = {
    plan: previous?.plan ?? candidate.plan,
    branch: previous?.branch ?? candidate.branch,
    commit: previous?.commit ?? candidate.commit,
    desired: previous?.desired ?? "stopped",
    deploymentIncomplete: previous ? previous.deploymentIncomplete : true,
    stage: "pending",
  };
  const checkpoint = await deps.lifecycle.checkpoint(candidate, previous);
  let commitDecided = false;
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
    if (previous) {
      await stopForTransition(previous, deps.lifecycle);
      await deps.lifecycle.retireSuperseded(previous, candidate);
    }
    if (intent.activation === "start") {
      await deps.lifecycle.up(candidate, checkpoint);
      candidate.desired = "running";
    }
    const decision = {
      ...candidate,
      recovery: { ...candidate.recovery!, stage: "committing" as const },
    };
    delete decision.deploymentIncomplete;
    await persistTarget(decision, deps.store);
    commitDecided = true;
    await checkpoint.commit();
    const completed: TargetRecord = { ...decision };
    delete completed.recovery;
    await persistTarget(completed, deps.store);
    return completed;
  } catch (error) {
    if (commitDecided)
      throw new RigError(
        "DEPLOY_COMMIT_PENDING",
        "The deployment was activated, but its commit finalization is incomplete.",
        "Run down for this Target to finish the recorded commit without restoring the previous build.",
        {},
        failureCauses(error),
      );
    try {
      await stopForTransition(candidate, deps.lifecycle);
      if (previous) await stopForTransition(previous, deps.lifecycle);
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
      try {
        await persistTarget(candidate, deps.store);
      } catch (persistenceError) {
        throw retainFailureCauses(persistenceError, error, persistenceError);
      }
      throw new RigError(
        "DEPLOY_ROLLBACK_BLOCKED",
        "Deployment failed and process cleanup could not be verified, or saved effects could not be restored.",
        "Run down for this Target and inspect its logs before retrying.",
        {},
        failureCauses(error, recoveryError),
      );
    }
    if (previous) {
      try {
        if (previous.desired === "running") await deps.lifecycle.up(previous);
        await persistTarget(previous, deps.store);
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
          "Run down for this Target and inspect its logs before retrying.",
          {},
          failureCauses(error, recoveryError),
        );
      }
    } else {
      candidate.desired = "stopped";
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
/** Explicit down is the recovery path; it stops both recorded providers before clearing the transition. */
export async function stopForRecovery(
  target: TargetRecord,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  if (!target.recovery) return target;
  await stopForTransition(target, deps.lifecycle);
  if (target.recovery.stage === "committing") {
    await deps.lifecycle.commitEffects(target);
    const completed = { ...target, desired: "stopped" as const };
    delete completed.recovery;
    await persistTarget(completed, deps.store);
    return completed;
  }
  const previous: TargetRecord = {
    ...target,
    plan: target.recovery.plan,
    branch: target.recovery.branch,
    commit: target.recovery.commit,
    desired: "stopped",
    deploymentIncomplete: target.recovery.deploymentIncomplete,
  };
  delete previous.recovery;
  await stopForTransition(previous, deps.lifecycle);
  await deps.lifecycle.restoreEffects(target);
  await persistTarget(previous, deps.store);
  return previous;
}
