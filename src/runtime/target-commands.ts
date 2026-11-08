import { sameConfigDigest } from "../config/config-digest";
import type { ConfigDocument, PlanJob, ProjectConfig } from "../config/types";
import type { RuntimeCommand } from "../daemon/protocol";
import {
  RigError,
  asRigError,
  failureCauses,
  retainFailureCauses,
} from "../domain/errors";
import { rigCommand, selectedTarget } from "../domain/rig-command";
import type {
  OperationRecord,
  ProjectRecord,
  TargetRecord,
} from "../domain/runtime";
import { isStopDetached } from "../domain/stop-budget";
import type { RuntimeDependencies } from "./contracts";
import type { CommandContext, SelectedTarget } from "./command-execution";
import { LATEST_BACKUP, backupStorage, selectBackup } from "./backups";
import { stopForRecovery } from "./deploy";
import { noRestore, settlePreviousRun, startJobRun, stopJobRuns } from "./jobs";
import { assertServiceEnvironments } from "./build-preparation";
import { assertPrepared } from "./preparation-evidence";
import type { OrphanSweep } from "./orphan-routes";
import { prepareTarget } from "./preparation";
import { destroyPreview } from "./previews";
import { releaseHeldCheckouts } from "./revisions";
import {
  activationJournal,
  intendRunning,
  intendStopped,
} from "./service-runs";
import { stopRecordedTarget } from "./stop";
import { recordStopKills } from "./stop-progress";
import {
  assertJobsCanRun,
  assertTransitionSettled,
  missingTarget,
} from "./target-refusals";
import { persistTarget, planTarget } from "./targets";

/* The commands that act on one admitted Target: start, stop and restart it, destroy a Preview, run a job or restore a
 * backup. Each runs under its Target's lease and records what it learns on the Operation's outcome as it goes. */

/** `rig run`: starts a run of the job `command.job` now. */
export async function runJob(
  command: RuntimeCommand,
  { name, configured }: SelectedTarget,
  { operationId, deps, outcome }: CommandContext,
): Promise<unknown> {
  const target = outcome.target;
  if (!target) throw missingTarget(command, name, outcome.project!.name);
  const job = runnableJob(target, command.job, configured.document);
  outcome.attempted = true;
  outcome.component = { kind: "job", name: job.name };
  const run = await startJobRun(
    target,
    job,
    { id: operationId, trigger: "manual" },
    deps,
  );
  await releaseHeldCheckouts(target, deps);
  return await outcome.finish("started", {
    job: job.name,
    startedAt: run.startedAt,
  });
}
/** `rig backup restore`: starts a run of the backup job that puts the backup `command.backup` (the latest by default)
 * back. */
export async function restoreBackup(
  command: RuntimeCommand,
  { name, configured }: SelectedTarget,
  { operationId, deps, outcome }: CommandContext,
): Promise<unknown> {
  const target = outcome.target;
  if (!target) throw missingTarget(command, name, outcome.project!.name);
  const job = runnableJob(target, command.job, configured.document);
  if (!job.backup)
    throw new RigError(
      "BACKUP_NOT_CONFIGURED",
      `${job.name} on ${target.name} is not a backup job, so it has no backups to restore.`,
      `Add backup: { keep: <n>, restore: <command> } to jobs.${job.name} in rig.yaml (rig-guide: Backups).`,
      { job: job.name },
    );
  if (job.backup.restore === undefined) throw noRestore(target, job.name);
  const which = command.backup ?? LATEST_BACKUP;
  // An id that names no backup is a mistake in the request, refused before anything is done.
  if (which !== LATEST_BACKUP)
    selectBackup(await deps.store.read(), target, job.name, which);
  const storage = backupStorage(deps);
  outcome.attempted = true;
  outcome.note = `${job.name} from ${which}`;
  outcome.component = { kind: "job", name: job.name };
  // A run of the job that ended but is not recorded yet is settled first, under this Operation's hold on the Target,
  // so its retention runs before the backup is chosen and can never delete the one chosen.
  await settlePreviousRun(target, job.name, deps);
  let backup;
  try {
    backup = selectBackup(await deps.store.read(), target, job.name, which);
  } catch (error) {
    if (which === LATEST_BACKUP) throw error;
    throw new RigError(
      "BACKUP_EXPIRED",
      `Backup ${which} of ${job.name} on ${target.name} was just removed: the run of ${job.name} that ended before this restore kept a newer backup, and keep let this one go.`,
      `Pick another backup (${rigCommand("backup list", { job: job.name, target })} shows them), then retry.`,
      { job: job.name, backup: which },
    );
  }
  outcome.note = `${job.name} from ${backup.id}`;
  if (!(await storage.exists(backup.path)))
    throw new RigError(
      "BACKUP_MISSING",
      `Backup ${backup.id} of ${job.name} on ${target.name} is no longer on disk (${backup.path}).`,
      `Restore another one (${rigCommand("backup list", { job: job.name, target })} shows them), or put the directory back.`,
      { job: job.name, backup: backup.id, path: backup.path },
    );
  const run = await startJobRun(
    target,
    job,
    {
      id: operationId,
      trigger: "restore",
      restore: { id: backup.id, path: backup.path },
    },
    deps,
  );
  await releaseHeldCheckouts(target, deps);
  return await outcome.finish("started", {
    job: job.name,
    backup: backup.id,
    startedAt: run.startedAt,
  });
}
/** `rig down --destroy`: stops a Preview, settling any recovery first, and deletes it with its storage. */
export async function destroyCommand(
  command: RuntimeCommand,
  { kind, name }: SelectedTarget,
  { admission, deps, outcome }: CommandContext,
): Promise<unknown> {
  if (kind !== "preview")
    throw new RigError(
      "DESTROY_TARGET",
      "Only Previews can be destroyed.",
      `Stop it with ${rigCommand("down", { project: outcome.project!.name, target: selectedTarget(command) })}.`,
    );
  let target = outcome.target;
  if (!target) throw missingTarget(command, name, outcome.project!.name);
  outcome.attempted = true;
  admission.phase("stopping", target);
  if (target.recovery) {
    // Job runs are confirmed stopped before a recovery stop changes the Target, so one that cannot be leaves the
    // recovery and the Services as they were. The ownership preflight comes after, in destroyPreview: it refuses
    // a Target with a recovery to settle.
    await stopJobRuns(target, deps);
    target = outcome.target = (await stopForRecovery(target, deps)).target;
  }
  await destroyPreview(target, deps, admission.phase);
  return await outcome.finish("stopped");
}
/** `rig up`, `rig down` and `rig restart`. A Working copy never started is planned and recorded first; a stopped one is
 * planned again from the current rig.yaml. An unresolved recovery is settled by down, and refuses the others. */
export async function lifecycleCommand(
  command: RuntimeCommand,
  { kind, name, configured }: SelectedTarget,
  context: CommandContext,
  sweep: OrphanSweep,
): Promise<unknown> {
  const { admission, deps, outcome } = context;
  const project = outcome.project!;
  const workingCopyDocument = (): ConfigDocument<ProjectConfig> => {
    if (!configured.document) throw configured.failure;
    return configured.document;
  };
  let target = outcome.target;
  if (!target && (command.action !== "up" || kind !== "working"))
    throw missingTarget(command, name, project.name);
  outcome.attempted = true;
  if (!target) {
    target = outcome.target = await planTarget(
      {
        command,
        kind,
        project,
        document: workingCopyDocument(),
      },
      deps,
    );
    await persistTarget(target, deps.store);
  } else if (
    command.action === "up" &&
    target.kind === "working" &&
    target.desired === "stopped" &&
    // An unresolved transition is settled by down before anything plans over it.
    !target.recovery
  )
    target = outcome.target = await replanWorkingCopy(
      target,
      command,
      project,
      workingCopyDocument(),
      deps,
    );
  // What a recovery stopped is this down's outcome too: the stop after it finds those processes gone.
  let recovered: OperationRecord["outcome"] = "unchanged";
  if (target.recovery) {
    if (command.action !== "down") assertTransitionSettled(target);
    admission.phase("stopping", target);
    const settled = await stopForRecovery(target, deps);
    target = outcome.target = settled.target;
    recovered = settled.outcome;
  }
  let result: OperationRecord["outcome"];
  const warnings: string[] = [];
  if (command.action === "down") {
    target.desired = "stopped";
    intendStopped(target);
    target.updatedAt = deps.now();
    await persistTarget(target, deps.store);
    admission.phase("stopping", target);
    // Its job runs first, with the stop budget each started with: a run may use the Services that stop after it. A job
    // that cannot be stopped never keeps the Services running; its failure is the Operation's once they stopped.
    let jobFailure: unknown;
    let stoppedJobs = 0;
    try {
      stoppedJobs = await stopJobRuns(target, deps);
    } catch (error) {
      if (isStopDetached(error)) throw error;
      jobFailure = error;
    }
    result = (await stopKeepingKills(target, context)).outcome;
    if (stoppedJobs || recovered === "stopped") result = "stopped";
    await releaseHeldCheckouts(target, deps);
    if (jobFailure !== undefined) throw jobFailure;
    recordStopKills(target, context.tracking()!.view);
    // A stop needs only the record, so an unreadable rig.yaml does not block it; the reply says what was not read.
    if (configured.failure !== undefined) {
      const failure = asRigError(configured.failure);
      warnings.push(
        `rig.yaml could not be used, so ${target.name} was stopped as it was recorded. ${failure.message} ${failure.hint}`,
      );
    }
  } else {
    // Whatever would refuse a restart refuses it here, with every Service still running. The route check keeps its
    // reservation until the start is over.
    const restarting =
      command.action === "restart"
        ? await checkedRestartPlan(
            target,
            workingCopyDocument,
            command,
            project,
            deps,
          )
        : undefined;
    try {
      if (restarting) {
        await sweep.before(restarting, () =>
          deps.lifecycle.checkRoute(restarting),
        );
        target.desired = "stopped";
        intendStopped(target);
        target.updatedAt = deps.now();
        await persistTarget(target, deps.store);
        admission.phase("stopping", target);
        deps.routeGuard?.watch(target);
        await stopKeepingKills(target, context, true);
        admission.phase("starting", target);
        if (target.kind === "working")
          target = outcome.target = await adoptWorkingCopyPlan(
            target,
            restarting,
            deps,
          );
      }
      // Only the Working copy builds here, from current source; a deployed Target starts from its deployment's preparation.
      if (target.kind === "working")
        await prepareTarget(
          target,
          command.action === "restart" ? "all" : "stopped",
          deps,
        );
      // The same text is no drift, whichever rigd parsed it. A changed text is drift only when what it says changed, so
      // a comment or layout edit is none, nor is renaming keys to their ADR 0011 names; a Target planned by a rigd that
      // recorded no digest is compared by text alone.
      const current = configured.document;
      const drift =
        target.kind === "working" &&
        target.configRevision !== undefined &&
        current !== undefined &&
        current.revision !== target.configRevision &&
        (target.configDigest === undefined ||
          !sameConfigDigest(current.config, target.configDigest));
      if (drift)
        warnings.push(
          `rig.yaml changed since ${target.name} was planned, and its running Services still use the earlier plan. Run ${rigCommand("restart", { target })} to apply the current rig.yaml.`,
        );
      const journal = activationJournal(target, "explicit", deps);
      try {
        // A route block no recorded Target owns (#336) never holds a hostname from this start.
        const starting = target;
        result = (
          await sweep.before(starting, () =>
            deps.lifecycle.up(starting, undefined, journal),
          )
        ).outcome;
      } catch (error) {
        // The rolled-back Services are recorded as not started; failing to say so leaves their outcome unknown, never retried.
        // A start whose clean-up rigd's shutdown detached rolled nothing back: its Services are left as a crash leaves them.
        if (!isStopDetached(error)) await journal.failed(error).catch(() => {});
        throw error;
      }
      intendRunning(target);
      // up installs, routes, and starts the recorded plan under its own
      // committed checkpoint, which is everything an incomplete deployment lacked.
      delete target.deploymentIncomplete;
      target.desired = "running";
    } finally {
      if (restarting)
        await deps.lifecycle.releaseRoute(restarting).catch(() => {});
    }
  }
  target.updatedAt = deps.now();
  await persistTarget(target, deps.store);
  // A start published every Tool, and a restart started every Service, from the current checkout: an earlier one a Tool's
  // shim or a kept Service ran in can go now.
  if (command.action !== "down")
    await releaseHeldCheckouts(target, deps).catch(() => {});
  return await outcome.finish(result, warnings.length ? { warnings } : {});
}
/** Stops `stopped` as `rig down` and `rig restart` do, and saves which Services it had to SIGKILL on the saved record as
 * soon as the stop is over, whether it succeeded or failed part-way, so status says so while they stay stopped: after
 * a down, or a restart that fails before it starts them again. The next start clears it. */
async function stopKeepingKills(
  stopped: TargetRecord,
  { deps, tracking }: Pick<CommandContext, "deps" | "tracking">,
  startFollows = false,
) {
  const view = tracking()!.view;
  // Marked on the Operation's own record as well, since what it saves later (a replan, the final record) starts from it.
  const keep = () =>
    !recordStopKills(stopped, view)
      ? Promise.resolve()
      : deps.store
          .update((state) => {
            const saved = state.targets.find((t) => t.id === stopped.id);
            if (saved) recordStopKills(saved, view);
          })
          .catch(() => {});
  try {
    const result = await stopRecordedTarget(
      stopped,
      deps.lifecycle,
      startFollows,
    );
    await keep();
    return result;
  } catch (error) {
    await keep();
    throw error;
  }
}
/** The job `rig run` names in `target`'s recorded plan, once the Target can run one: deployed completely, meant to run
 * and in no transition (whether it is on was checked before). Every plan has every job of its rig.yaml, whatever the job's
 * targets, which decide scheduling only. A name the plan lacks fails JOB_UNKNOWN, naming the jobs it has, or the command
 * that plans the Target again when the current rig.yaml declares the job. */
function runnableJob(
  target: TargetRecord,
  name: string | undefined,
  document: ConfigDocument<ProjectConfig> | undefined,
): PlanJob {
  assertJobsCanRun(target);
  const jobs = target.plan.jobs ?? [];
  const job = jobs.find((candidate) => candidate.name === name);
  if (job) return job;
  const declared =
    name !== undefined &&
    document?.config.jobs !== undefined &&
    Object.hasOwn(document.config.jobs, name);
  // The working Target is planned again by rig restart; a deployed one by a deploy of a Commit whose rig.yaml has the job.
  const replan =
    target.kind === "working"
      ? `run ${rigCommand("restart", { target })}`
      : `deploy ${target.kind === "stable" ? "stable" : "the Preview"} again from a Commit that has it (${rigCommand("deploy", { target })})`;
  throw new RigError(
    "JOB_UNKNOWN",
    `${target.name} has no job named '${name ?? ""}'.`,
    declared
      ? `rig.yaml declares it, but ${target.name} was planned before it did; ${replan}.`
      : jobs.length
        ? `Run one of: ${jobs.map((candidate) => candidate.name).join(", ")}.`
        : `${target.name} has no jobs. Declare one under jobs in rig.yaml, then ${replan}.`,
    { job: name, known: jobs.map((candidate) => candidate.name) },
  );
}
/** What a restart of `target` starts, before anything of it stops, or the refusal that leaves it running as it was: the
 * Working copy's plan from the current rig.yaml (its `document`, read only for it), or a deployed Target's recorded plan,
 * whose preparation must be complete. The first thing to run must be able to: the Working copy's first build, whose
 * environment nothing runs before to write, or else each Service, whose environment must compose. With a build, a later
 * build's and each Service's wait for their own turn, since an earlier build may write an env file they read; only a value
 * Rig refuses, in a file that exists, is refused now. */
async function checkedRestartPlan(
  target: TargetRecord,
  document: () => ConfigDocument<ProjectConfig>,
  command: RuntimeCommand,
  project: ProjectRecord,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  assertPrepared(target);
  const planned =
    target.kind === "working"
      ? await planTarget(
          {
            command,
            kind: "working",
            project,
            document: document(),
            existing: target,
            replacesRunning: true,
          },
          deps,
        )
      : target;
  if (planned.kind === "working" && planned.plan.builds?.length) {
    await deps.lifecycle.checkEnvironmentValues(planned);
    await deps.lifecycle.checkFirstBuild(planned);
    return planned;
  }
  await assertServiceEnvironments(planned, deps.lifecycle);
  return planned;
}
/** A stopped working Target is re-planned from the current rig.yaml before it starts, keeping its id, data root, and recorded ports. */
async function replanWorkingCopy(
  target: TargetRecord,
  command: RuntimeCommand,
  project: ProjectRecord,
  document: ConfigDocument<ProjectConfig>,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  return await adoptWorkingCopyPlan(
    target,
    await planTarget(
      { command, kind: "working", project, document, existing: target },
      deps,
    ),
    deps,
  );
}
/** Makes `replanned` the stopped working Target's recorded plan. */
async function adoptWorkingCopyPlan(
  target: TargetRecord,
  replanned: TargetRecord,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  // A Service the new plan drops would have nothing left to stop it once its plan is replaced: one a failed down left
  // running is stopped first, and while it cannot be, the plan that names it stays recorded.
  const dropped = target.plan.components.filter(
    (component) =>
      component.kind === "managed" &&
      !replanned.plan.components.some(
        (planned) =>
          planned.kind === "managed" && planned.name === component.name,
      ),
  );
  if (dropped.length)
    await deps.lifecycle.down({
      ...target,
      plan: { ...target.plan, components: dropped },
    });
  // A Service a failed down left running is adopted by the next up, not started; its record is what explains its later exit.
  if (target.services) replanned.services = target.services;
  // The plan being replaced is stopped; an executable only it names (a removed Tool, or an alias under the old Target name) goes with it.
  // Retirement and the new plan are published together or not at all.
  const checkpoint = await deps.lifecycle.checkpoint(replanned, target);
  try {
    await deps.lifecycle.retireSuperseded(target, replanned);
    // Saved with the plan, the decision makes an interrupted finalization finish the commit instead of restoring retired executables.
    await persistTarget(
      {
        ...replanned,
        recovery: {
          plan: target.plan,
          desired: "stopped",
          stage: "committing",
        },
      },
      deps.store,
    );
  } catch (error) {
    try {
      await checkpoint.rollback();
    } catch (recoveryError) {
      throw retainFailureCauses(error, error, recoveryError);
    }
    throw error;
  }
  try {
    await checkpoint.commit();
    await persistTarget(replanned, deps.store);
  } catch (error) {
    throw new RigError(
      "REPLAN_COMMIT_PENDING",
      `The new plan of ${replanned.name} was saved, but its commit finalization is incomplete.`,
      `Run ${rigCommand("down", { target: replanned })} to finish the recorded commit, then run the command again.`,
      {},
      failureCauses(error),
    );
  }
  return replanned;
}
