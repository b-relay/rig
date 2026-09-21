import { activationJournal, intendStopped } from "./supervision";
import type { TargetRecord } from "../domain/runtime";
import {
  RigError,
  failureCauses,
  failureReason,
  retainFailureCauses,
  type FailureCauses,
} from "../domain/errors";
import { within } from "../domain/paths";
import type { RuntimeDependencies } from "./contracts";
import { persistTarget } from "./targets";
import { uncertainAttempt } from "./lifecycle";
import { prepareTarget } from "./preparation";
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
/** The saved recovery record owns both plans until candidate activation or verified rollback finishes.
 * The candidate is prepared (dependencies, then every build unit) while the previous plan keeps serving, so a failed
 * build never stops it; `prepare` ends there, leaving every Service stopped. */
export async function activateDeployment(
  candidate: TargetRecord,
  previous: TargetRecord | undefined,
  intent: { activation: "start" | "prepare"; operationId?: string },
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
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
  const checkpoint = await deps.lifecycle.checkpoint(candidate, previous);
  let commitDecided = false,
    transitioned = false;
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
    transitioned = true;
    if (previous) {
      await deps.lifecycle.down(previous);
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
      // A failed preparation changed nothing: the previous Deployment, whose process keys the candidate shares, keeps running.
      if (transitioned) {
        await deps.lifecycle.down(candidate);
        if (previous) await deps.lifecycle.down(previous);
      }
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
        "Run down for this Target and inspect its logs before retrying.",
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
          "Run down for this Target and inspect its logs before retrying.",
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
/** Explicit down is the recovery path; it stops both recorded providers before clearing the transition. */
export async function stopForRecovery(
  target: TargetRecord,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  if (!target.recovery) return target;
  await deps.lifecycle.down(target);
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
  await deps.lifecycle.down(previous);
  await deps.lifecycle.restoreEffects(target);
  await persistTarget(previous, deps.store);
  return previous;
}

/** The checkout a deployed Target owns under its revisions directory; local Targets have none. */
export function ownedRevision(record: TargetRecord): string | undefined {
  return record.sourceRoot &&
    within(record.sourceRoot, record.plan.workspacePath)
    ? record.plan.workspacePath
    : undefined;
}
/** A revision that stayed on disk after a deployment decision, with the reason for the user and the diagnostic log. */
export interface RetainedRevision {
  readonly workspacePath: string;
  readonly warning: string;
  readonly causes: FailureCauses;
}
/** Give back the revisions among `records` that no inventory record uses any more, once the deployment
 * outcome is saved. Each failure is reported, never thrown: the outcome stands and the checkout stays. */
export async function releaseUnreferencedRevisions(
  records: readonly TargetRecord[],
  deps: Pick<RuntimeDependencies, "sources" | "store">,
): Promise<RetainedRevision[]> {
  const referenced = new Set(
    (await deps.store.read()).targets.flatMap((record) => [
      record.plan.workspacePath,
      ...(record.recovery ? [record.recovery.plan.workspacePath] : []),
    ]),
  );
  const retained: RetainedRevision[] = [];
  for (const record of records) {
    const workspacePath = ownedRevision(record);
    if (!workspacePath || referenced.has(workspacePath)) continue;
    try {
      await deps.sources.release({ project: record.projectId, workspacePath });
    } catch (error) {
      retained.push({
        workspacePath,
        warning: `Revision ${workspacePath} was not removed: ${failureReason(error)} Delete it by hand to reclaim disk.`,
        causes: failureCauses(error),
      });
    }
  }
  return retained;
}
