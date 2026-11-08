import { recordActivity } from "../domain/activity";
import { RigError, failureReason } from "../domain/errors";
import type { OperationPhase } from "../domain/operation-progress";
import { rigCommand } from "../domain/rig-command";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { queueTargetBackups, removeQueuedBackups } from "./backups";
import { stopJobRuns } from "./jobs";
import { forgetReleasedCheckouts, ownedRevision } from "./revisions";
import { intendStopped } from "./service-runs";
import { persistTarget } from "./targets";

/** A Preview removed to make room for another, as reported to the user. */
export interface RetiredPreview {
  target: string;
  branch?: string;
  reason: "Preview limit";
}
/** The oldest Previews that must leave so a new Preview fits under the Host limit; none while the Project is under it.
 * `creating` names the Previews other deploys are creating right now: they count against the limit whether or not they
 * are recorded yet, and are never chosen to leave. Rejects PREVIEW_LIMIT under the reject policy or when only Previews
 * being created could make room, and DEPLOY_RECOVERY when a chosen Preview is mid-transition. */
export function previewsToReplace(
  targets: readonly TargetRecord[],
  creating: ReadonlySet<string>,
  policy: { max: number; replace_policy: "oldest" | "reject" },
): TargetRecord[] {
  const previews = targets.filter((t) => t.kind === "preview");
  const unrecorded = [...creating].filter(
    (name) => !previews.some((preview) => preview.name === name),
  );
  const overflow = previews.length + unrecorded.length - policy.max + 1;
  if (overflow <= 0) return [];
  if (policy.replace_policy === "reject")
    throw new RigError(
      "PREVIEW_LIMIT",
      "The Project has reached its Preview limit.",
      "Remove an existing Preview or change the Host Preview limit.",
    );
  const oldest = previews
    .filter((preview) => !creating.has(preview.name))
    .sort(
      (a, b) =>
        evictionRank(a) - evictionRank(b) ||
        a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, overflow);
  if (oldest.length < overflow)
    throw new RigError(
      "PREVIEW_LIMIT",
      "The Project's Preview limit is taken by Previews that are being deployed right now.",
      "Wait for those deploys to finish, then retry; the oldest Preview is replaced then.",
    );
  if (oldest.some((t) => t.recovery || t.destructionPending))
    throw new RigError(
      "DEPLOY_RECOVERY",
      "The oldest Preview has an unresolved transition.",
      "Finish that Preview's pending down or destroy before replacing it.",
    );
  return oldest;
}
/** Previews leave in this order at the limit: ones whose deploy never completed, then stopped ones, then running ones. */
function evictionRank(target: TargetRecord): number {
  if (target.deploymentIncomplete) return 0;
  return target.desired === "stopped" ? 1 : 2;
}
/** Verified shutdown, then committed route/artifact retirement, then deletion of the Preview's owned storage.
 * Inventory (marked destructionPending) remains the retry handle until every owned byte is gone. */
export async function destroyPreview(
  target: TargetRecord,
  deps: RuntimeDependencies,
  /** Told when the Preview has stopped and its storage is being deleted. */
  progress: (phase: OperationPhase) => void = () => {},
): Promise<void> {
  await deps.files.inspectPreviewDeletion({
    root: deps.root,
    target,
    state: await deps.store.read(),
  });
  // A job run, possibly on a checkout an earlier deploy kept for it, must be confirmed stopped before anything of the
  // Preview changes: one that cannot be fails the destroy, and the Preview's storage stays.
  await stopJobRuns(target, deps);
  target.desired = "stopped";
  intendStopped(target);
  target.destructionPending = true;
  target.updatedAt = deps.now();
  await persistTarget(target, deps.store);
  await retireForDestruction(target, deps);
  progress("destroying");
  await deps.files.destroyPreview({
    root: deps.root,
    target,
    state: await deps.store.read(),
  });
  // The checkout left with the Preview root; this drops its worktree registration from the mirror.
  const workspacePath = ownedRevision(target);
  if (workspacePath)
    await deps.sources.release({ project: target.projectId, workspacePath });
  // The Preview's backups go with it (ADR 0017), queued in the write that forgets it, so a failed deletion is retried.
  await deps.store.update((s) => {
    s.targets = s.targets.filter((t) => t.id !== target.id);
    queueTargetBackups(s, target.id);
  });
  await removeQueuedBackups(deps, target.id);
  // Checkouts job runs kept went with the Preview root too; their registrations are dropped, and a record is forgotten only
  // once that worked, so a failure is offered again by the scheduler.
  await forgetReleasedCheckouts(
    ((await deps.store.read()).heldCheckouts ?? []).filter(
      (kept) => kept.target === target.id,
    ),
    deps,
  ).catch(() => {});
}
/**
 * Retire a Preview marked for destruction. `retire` leaves effects changed only
 * when it fails with RETIRE_COMMIT_PENDING or RETIRE_ROLLBACK; any other
 * refusal (missing provider, uncertain stop, ...) leaves the Target intact, so
 * the pending-destruction lock is released and the Preview may be restarted or
 * redeployed. The refusal is rethrown unchanged.
 */
async function retireForDestruction(
  target: TargetRecord,
  deps: RuntimeDependencies,
): Promise<void> {
  try {
    await deps.lifecycle.retire(target);
  } catch (error) {
    // A stop detached by rigd's shutdown is still under way: the pending destroy is kept for the retry that finishes it.
    const effectsChanged =
      error instanceof RigError &&
      (error.code === "RETIRE_COMMIT_PENDING" ||
        error.code === "RETIRE_ROLLBACK" ||
        error.code === "STOP_DETACHED");
    if (!effectsChanged) {
      delete target.destructionPending;
      target.updatedAt = deps.now();
      await persistTarget(target, deps.store);
    }
    throw error;
  }
}
/** Destroy replaced Previews after the new one is committed, recording each removal as its own destroy operation.
 * A removal that fails leaves the new Preview deployed and the old record in place for an explicit destroy, and is reported as a warning. */
export async function destroyReplacedPreviews(
  replacements: readonly TargetRecord[],
  project: ProjectRecord,
  operationId: string,
  deps: RuntimeDependencies,
): Promise<{ retired: RetiredPreview[]; warnings: string[] }> {
  const retired: RetiredPreview[] = [];
  const warnings: string[] = [];
  for (const replacement of replacements) {
    try {
      await destroyPreview(replacement, deps);
      retired.push({
        target: replacement.name,
        ...(replacement.branch ? { branch: replacement.branch } : {}),
        reason: "Preview limit",
      });
      await deps.store.update((state) => {
        recordActivity(state, {
          id: `${operationId}:${replacement.id}`,
          projectId: project.id,
          project: project.name,
          target: replacement.name,
          action: "destroy",
          outcome: "stopped",
          occurredAt: deps.now(),
          message: "Preview limit",
        });
      });
    } catch (error) {
      const failure = failureReason(error);
      warnings.push(
        `Preview ${replacement.branch ?? replacement.name} was not removed: ${failure} Run ${rigCommand("down", { target: replacement }, "--destroy")} to finish; the Project is over its Preview limit until then.`,
      );
    }
  }
  return { retired, warnings };
}
