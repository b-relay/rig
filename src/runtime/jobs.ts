import type { PlanJob } from "../config/types";
import { recordActivity } from "../domain/activity";
import { RigError, diagnosticErrorCode } from "../domain/errors";
import { targetSelector } from "../domain/target-selector";
import type {
  BackupRecord,
  HeldCheckout,
  JobOutcome,
  JobRecord,
  JobRun,
  OperationRecord,
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { ProcessObservation } from "../providers/contracts";
import {
  backupStorage,
  allocateBackup,
  madeBackupDirectory,
  queueRemoval,
  recordBackupEnd,
  settleBackupFiles,
  type BackupDependencies,
} from "./backups";
import type { StopControl, TargetLifecycle } from "./lifecycle";

/* Every function here that changes a run, or signals its process, is called by an Operation that holds the run's Target
 * (rig run, rig down, a scheduled start or settlement, a destroy, rigd's first pass), so no other start or stop of the
 * job's one process key can interleave. A run is recorded before its process starts, a decision to stop it before its
 * stop signal, and a checkout it kept in the same write as its end, so a rigd that stops at any step finds what is left. */

/** What a job run needs from the runtime around it. */
export interface JobRunDependencies extends BackupDependencies {
  store: Pick<StateStore, "read" | "update">;
  lifecycle: Pick<TargetLifecycle, "startJob" | "observeJob" | "stopJob">;
  /** ISO timestamp. */
  now(): string;
}
/** What recording a run's end needs: the state, the clock, and a backup job's directories. */
type EndDependencies = Pick<
  JobRunDependencies,
  "store" | "now" | "backups" | "diagnostic" | "id"
>;
/** How many of the scheduled times a job handled most recently its record keeps: an hour of an every-minute schedule.
 * The clock set back past one of them never runs it again. */
export const JOB_HANDLED_LIMIT = 60;
/** The variable a backup job's command, and a restore, find their backup directory in. */
export const BACKUP_DIR_VARIABLE = "RIG_BACKUP_DIR";

/** Whether `run` is past its timeout once `elapsedMs` of elapsed time have passed since it started. */
export function pastTimeout(run: JobRun, elapsedMs: number): boolean {
  return run.timeout !== undefined && elapsedMs >= run.timeout * 1000;
}
/** The record of `job` of the Target `targetId`, if any. */
export function findJobRecord(
  state: { readonly jobs?: readonly JobRecord[] },
  targetId: string,
  job: string,
): JobRecord | undefined {
  return state.jobs?.find(
    (record) => record.target === targetId && record.job === job,
  );
}
function ensureJobRecord(
  state: RuntimeState,
  targetId: string,
  job: string,
): JobRecord {
  const found = findJobRecord(state, targetId, job);
  if (found) return found;
  const created: JobRecord = { target: targetId, job };
  (state.jobs ??= []).push(created);
  return created;
}

/** Pure: how `run` ended, from what its process left behind. A stop Rig decided on (`run.stopping`) says it: stopped by
 * Rig, or timed out. Otherwise an exit record of this run says it: exit 0 succeeded, anything else failed. Otherwise
 * nothing recorded how it ended. It ended when its process did, as this run's exit record or Rig's stop of it says,
 * however much later that is recorded (`at`); `at` itself when neither says it trustworthily (between the run's start
 * and `at`). */
export function endedRun(
  run: JobRun,
  observation: Pick<
    ProcessObservation,
    "incarnation" | "exitCode" | "signal" | "exitedAt"
  >,
  at: string,
): JobRun {
  const evidence =
    observation.incarnation === run.id &&
    (observation.exitCode !== undefined || observation.signal !== undefined);
  const within = (time: string | undefined) =>
    time !== undefined &&
    Date.parse(time) >= Date.parse(run.startedAt) &&
    Date.parse(time) <= Date.parse(at)
      ? time
      : undefined;
  const finishedAt =
    (evidence ? within(observation.exitedAt) : undefined) ??
    within(run.stopping?.endedAt) ??
    at;
  const outcome: JobOutcome =
    run.stopping?.cause ??
    (evidence
      ? observation.exitCode === 0
        ? "succeeded"
        : "failed"
      : "unknown");
  const { stopping: _decided, ...rest } = run;
  return {
    ...rest,
    finishedAt,
    outcome,
    ...(evidence && observation.exitCode !== undefined
      ? { exitCode: observation.exitCode }
      : {}),
    ...(evidence && observation.signal !== undefined
      ? { signal: observation.signal }
      : {}),
  };
}

/** Records the end of the run `runId` of `job` from `observation`, as the record says it now (its stop decision
 * included), with its Activity entry; nothing when the record names another run by now. A checkout the run kept, one
 * its Target no longer plans from, is recorded in the same write to be given back. Resolves the ended run, if recorded. */
async function recordJobEnd(
  target: Pick<TargetRecord, "id" | "projectId" | "name">,
  job: string,
  runId: string,
  observation: ProcessObservation,
  deps: EndDependencies,
): Promise<JobRun | undefined> {
  let ended: JobRun | undefined;
  let backup: BackupRecord | undefined;
  // A backup run that exits 0 but left no real directory (it deleted $RIG_BACKUP_DIR, or replaced it with a symlink) keeps
  // nothing. Looked at before the write, which cannot wait on the disk; the caller holds the Target, so the run is the same.
  const made = findJobRecord(await deps.store.read(), target.id, job)?.running
    ?.backup;
  const lost =
    made !== undefined &&
    deps.backups !== undefined &&
    !(await deps.backups.exists(made.path));
  await deps.store.update((state) => {
    const record = findJobRecord(state, target.id, job);
    if (record?.running?.id !== runId) return;
    ended = endedRun(record.running, observation, deps.now());
    if (
      lost &&
      ended.backup?.path === made.path &&
      ended.outcome === "succeeded"
    )
      ended.backup = { ...ended.backup, lost: true };
    delete record.running;
    record.last = ended;
    // A backup run's directory becomes a backup, or is queued for deletion, in the same write as its end.
    backup = recordBackupEnd(state, target, job, ended);
    recordActivity(state, jobActivity(state, target, job, ended));
    const current = state.targets.find((t) => t.id === target.id);
    const workspace = ended.workspace;
    if (
      workspace !== undefined &&
      workspace !== current?.plan.workspacePath &&
      workspace !== current?.recovery?.plan.workspacePath
    )
      holdCheckout(state, {
        target: target.id,
        project: target.projectId,
        workspace,
      });
  });
  // Assigned in the write above, which the compiler cannot see.
  const finished = ended as JobRun | undefined;
  if (finished?.backup)
    await settleBackupFiles(target, backup as BackupRecord | undefined, deps);
  return finished;
}
/** Records `checkout` among the held checkouts to give back, once. */
export function holdCheckout(
  state: RuntimeState,
  checkout: HeldCheckout,
): void {
  if (
    !state.heldCheckouts?.some(
      (held) =>
        held.target === checkout.target &&
        held.workspace === checkout.workspace,
    )
  )
    (state.heldCheckouts ??= []).push(checkout);
}

/** How settling a run went: a process of it still runs, that cannot be told, the run ended and its end was recorded, or
 * the record names another run by now. */
export type JobSettlement = "running" | "unknown" | "settled" | "gone";
/** Settles the run `runId` of `job` when its process is gone: records how it ended. The caller holds the Target. */
export async function settleJobRun(
  target: TargetRecord,
  job: string,
  runId: string,
  deps: EndDependencies & {
    lifecycle: Pick<TargetLifecycle, "observeJob">;
  },
): Promise<JobSettlement> {
  const observed = await deps.lifecycle.observeJob(target, job);
  if (observed.state !== "stopped") return observed.state;
  return (await recordJobEnd(target, job, runId, observed, deps))
    ? "settled"
    : "gone";
}

/** Stops the run `run` of `job` and records it ended for `cause`. The caller holds the Target, so the process under the
 * job's key is this run's when it carries this run's incarnation; a process of another run is never signalled. The
 * decision is recorded before the stop signal, so a rigd that stops before the end is recorded still records the cause.
 * A run whose process already ended is settled with its own exit. */
export async function stopJobRun(
  target: TargetRecord,
  job: string,
  run: JobRun,
  cause: "stopped" | "timed-out",
  deps: EndDependencies & {
    lifecycle: Pick<TargetLifecycle, "observeJob" | "stopJob">;
  },
  stops?: StopControl,
): Promise<JobSettlement> {
  const stopped = await stopJobProcess(target, job, run, cause, deps, stops);
  if (stopped !== "ended") return stopped;
  return await settleJobRun(target, job, run.id, deps);
}
/** Stops the process of the run `run` of `job`, if it still runs, and leaves recording its end to the caller: the decision
 * and its cause are recorded before the stop signal, and when the stop found the process gone after it. Only a process
 * carrying the run's incarnation is ever signalled, so this needs no hold on the Target: a run started meanwhile (once
 * this one ended) is left alone. `ended` once nothing of the run runs; `unknown` when its process cannot be shown to be
 * this run's; `gone` when the record names another run by now. */
async function stopJobProcess(
  target: TargetRecord,
  job: string,
  run: JobRun,
  cause: "stopped" | "timed-out",
  deps: Pick<EndDependencies, "store" | "now"> & {
    lifecycle: Pick<TargetLifecycle, "observeJob" | "stopJob">;
  },
  stops?: StopControl,
): Promise<"ended" | "unknown" | "gone"> {
  const observed = await deps.lifecycle.observeJob(target, job);
  if (observed.state === "unknown") return "unknown";
  if (observed.state !== "running") return "ended";
  // Only a process that names this run is signalled. One with another incarnation, or none (a lease that did not record
  // it), cannot be shown to be this run's, so it stays uncertain rather than be stopped in its place.
  if (observed.incarnation !== run.id) return "unknown";
  let decided = false;
  await deps.store.update((state) => {
    const record = findJobRecord(state, target.id, job);
    if (record?.running?.id !== run.id) return;
    record.running.stopping ??= { cause, at: deps.now() };
    decided = true;
  });
  if (!decided) return "gone";
  const result = await deps.lifecycle.stopJob(
    target,
    {
      name: job,
      incarnation: run.id,
      ...(run.stopTimeout !== undefined
        ? { stopTimeout: run.stopTimeout }
        : {}),
    },
    stops,
  );
  // The stop removed the process's exit record, so its end is recorded here.
  if (result.outcome === "stopped") {
    const endedAt = deps.now();
    await deps.store.update((state) => {
      const stopping = findJobRecord(state, target.id, job)?.running;
      if (stopping?.id === run.id && stopping.stopping)
        stopping.stopping.endedAt ??= endedAt;
    });
  }
  return "ended";
}
/** Stops the run `runId` of `job`, which the scheduler found past its timeout, whether or not an Operation holds its
 * Target, recorded as timed out: a deploy or another long Operation on the Target never extends a run's limit. Its end is
 * recorded later, under the Target's lease (`settleJobRun`). Nothing when the record names another run by now. */
export async function enforceJobDeadline(
  target: TargetRecord,
  job: string,
  runId: string,
  deps: Pick<JobRunDependencies, "store" | "now"> & {
    lifecycle: Pick<TargetLifecycle, "observeJob" | "stopJob">;
  },
  stops?: StopControl,
): Promise<void> {
  const run = findJobRecord(await deps.store.read(), target.id, job)?.running;
  if (run?.id !== runId) return;
  await stopJobProcess(target, job, run, "timed-out", deps, stops);
}

/** Stops every run of `target`'s jobs in progress, each within the stop_timeout it started with, and records each as
 * stopped by Rig; resolves how many ended. A run whose stop cannot be confirmed (its process still runs, or cannot be
 * shown to be this run's) fails JOB_STOP_UNVERIFIED. rig down, a Preview destroy, a Target turned off and rigd's first pass for a Target meant to be stopped
 * use it; a deploy does not, so a run finishes on the checkout it started from. The caller holds the Target. Every run is
 * attempted; the first failure is thrown once all were. */
export async function stopJobRuns(
  target: TargetRecord,
  deps: EndDependencies & {
    lifecycle: Pick<TargetLifecycle, "observeJob" | "stopJob">;
  },
  stops?: StopControl,
): Promise<number> {
  const running = ((await deps.store.read()).jobs ?? []).filter(
    (record) => record.target === target.id && record.running,
  );
  const failures: unknown[] = [];
  let ended = 0;
  for (const record of running)
    try {
      const settled = await stopJobRun(
        target,
        record.job,
        record.running!,
        "stopped",
        deps,
        stops,
      );
      if (settled === "settled") ended++;
      // A stop that cannot be confirmed is a failure: nothing may treat the job as stopped (and, say, delete its checkout).
      else if (settled !== "gone")
        failures.push(
          new RigError(
            "JOB_STOP_UNVERIFIED",
            `${record.job} on ${target.name} could not be confirmed stopped: its process ${settled === "running" ? "is still running" : "could not be inspected or does not name its run"}.`,
            `Run rig doctor, inspect the process, then retry rig down ${targetSelector(target)}.`,
            { job: record.job, run: record.running!.id, state: settled },
          ),
        );
    } catch (error) {
      failures.push(error);
    }
  if (failures.length) throw failures[0];
  return ended;
}

/** What starts one run. */
export interface JobRunRequest {
  /** The run's identity: its process's incarnation and its Activity entries' id. */
  id: string;
  trigger: JobRun["trigger"];
  /** The scheduled time a scheduled run is for (Unix milliseconds). */
  scheduledFor?: number;
  /** For a restore (`trigger: "restore"`): the backup its `restore` command reads. */
  restore?: { id: string; path: string };
}

/** Starts a run of `job` on `target`, which the caller holds: a run still in progress (a restore included) refuses it with
 * JOB_RUNNING (one whose process is gone is settled first, a checkout it kept recorded with its end). The run is recorded
 * before its process starts, with the checkout it runs from, so a rigd that stops in between finds it and settles it and a
 * deploy keeps that checkout until it ends; a start that fails is recorded as start-failed and rethrown. Scheduled runs
 * also record the time they are for. A backup job's run (not a restore) records a fresh directory, then makes it, and
 * hands it to the command as $RIG_BACKUP_DIR; a restore runs the job's `restore` command with $RIG_BACKUP_DIR set to the
 * backup it reads. */
export async function startJobRun(
  target: TargetRecord,
  job: PlanJob,
  request: JobRunRequest,
  deps: JobRunDependencies,
): Promise<JobRun> {
  await settlePreviousRun(target, job.name, deps);
  const startedAt = deps.now();
  const restoreCommand = job.backup?.restore;
  if (request.restore && restoreCommand === undefined)
    throw noRestore(job.name);
  const storage =
    job.backup && !request.restore ? backupStorage(deps) : undefined;
  const run: JobRun = {
    id: request.id,
    trigger: request.trigger,
    ...(request.scheduledFor !== undefined
      ? { scheduledFor: new Date(request.scheduledFor).toISOString() }
      : {}),
    startedAt,
    workspace: target.plan.workspacePath,
    ...(job.timeout !== undefined ? { timeout: job.timeout } : {}),
    ...(job.stopTimeout !== undefined ? { stopTimeout: job.stopTimeout } : {}),
    ...(request.restore
      ? { restore: { id: request.restore.id, path: request.restore.path } }
      : {}),
  };
  // A backup run's directory is allocated in the write that records the run, before it is made.
  let allocated: JobRun["backup"];
  await deps.store.update((state) => {
    if (storage && job.backup) {
      allocated = {
        ...allocateBackup(state, target, job.name, startedAt, storage),
        keep: job.backup.keep,
      };
      run.backup = allocated;
    }
    const record = ensureJobRecord(state, target.id, job.name);
    record.running = run;
    if (run.scheduledFor) handledTime(record, run.scheduledFor);
  });
  /** Whether this run made its directory, which is then its own to delete. */
  let created = false;
  try {
    if (allocated) {
      // Made exclusively, then recorded as made before the process starts: a rigd that stops in between leaves a
      // directory it cannot show this run made, and so never deletes it.
      await storage!.create(allocated.path);
      created = true;
      run.backup = { ...allocated, made: true };
      await deps.store.update((state) => {
        const record = findJobRecord(state, target.id, job.name);
        if (record?.running?.id === run.id) record.running.backup = run.backup;
      });
    }
    const directory = allocated?.path ?? request.restore?.path;
    await deps.lifecycle.startJob(
      target,
      request.restore ? { ...job, command: restoreCommand! } : job,
      run.id,
      directory !== undefined
        ? { [BACKUP_DIR_VARIABLE]: directory }
        : undefined,
    );
  } catch (error) {
    const failed: JobRun = {
      ...run,
      finishedAt: deps.now(),
      outcome: "start-failed",
      errorCode: diagnosticErrorCode(error),
    };
    // A manual run's failure is the rig run Operation's own outcome, recorded with it; a scheduled one has no other entry.
    await deps.store
      .update((state) => {
        const record = findJobRecord(state, target.id, job.name);
        if (record?.running?.id !== run.id) return;
        delete record.running;
        record.last = failed;
        // A directory the run made goes; one it found there is not Rig's, and stays.
        if (allocated && created) queueRemoval(state, target, allocated.path);
        if (run.trigger === "schedule")
          recordActivity(state, jobActivity(state, target, job.name, failed));
      })
      .catch(() => {});
    if (allocated && created) await settleBackupFiles(target, undefined, deps);
    throw error;
  }
  return run;
}
/** Settles the run of `job` recorded in progress, if its process is gone (recording its end, so a backup run's retention
 * is applied now), or refuses with JOB_RUNNING while it still goes. The caller holds the Target, so nothing else settles or
 * starts a run of the job until it lets go: a restore calls it before it chooses a backup, so retention never deletes the
 * backup it chose. */
export async function settlePreviousRun(
  target: TargetRecord,
  job: string,
  deps: EndDependencies & {
    lifecycle: Pick<TargetLifecycle, "observeJob">;
  },
): Promise<void> {
  const recorded = findJobRecord(
    await deps.store.read(),
    target.id,
    job,
  )?.running;
  if (!recorded) return;
  const settled = await settleJobRun(target, job, recorded.id, deps);
  if (settled === "running" || settled === "unknown")
    throw new RigError(
      "JOB_RUNNING",
      recorded.trigger === "restore"
        ? `A restore of ${job} is still running on ${target.name} (started ${recorded.startedAt}).`
        : `${job} is still running on ${target.name} (started ${recorded.startedAt}).`,
      `Wait for it to finish (rig status shows it), or stop it with rig down. Runs of one job, restores included, never overlap.`,
      { job, run: recorded.id, startedAt: recorded.startedAt },
    );
}
/** The refusal of a restore for a job without a `restore` command. */
export function noRestore(job: string): RigError {
  return new RigError(
    "BACKUP_NO_RESTORE",
    `${job} has no restore command, so Rig cannot restore its backups.`,
    `Add jobs.${job}.backup.restore to rig.yaml (the command that puts $RIG_BACKUP_DIR back, such as pg_restore --clean ...), then plan the Target again: rig restart working, or deploy.`,
    { job },
  );
}

/** Records that the scheduled time `scheduledFor` (Unix milliseconds) of `job` was skipped because `running` was still
 * going. Activity records the first time a run makes the schedule skip; later ones are counted on the run. */
export async function recordSkippedRun(
  target: Pick<TargetRecord, "id" | "projectId" | "name">,
  job: string,
  scheduledFor: number,
  id: string,
  deps: Pick<JobRunDependencies, "store" | "now">,
): Promise<void> {
  const at = new Date(scheduledFor).toISOString();
  await deps.store.update((state) => {
    const record = ensureJobRecord(state, target.id, job);
    handledTime(record, at);
    const running = record.running;
    if (!running) return;
    const first = running.skipped === undefined;
    running.skipped = (running.skipped ?? 0) + 1;
    if (first)
      recordActivity(state, {
        id,
        projectId: target.projectId,
        project: projectName(state, target),
        target: target.name,
        component: { kind: "job", name: job },
        action: "job",
        outcome: "skipped",
        occurredAt: deps.now(),
        message: `${job}: skipped the run scheduled for ${at}; the run started ${running.startedAt} is still going. Later times are skipped until it ends, and counted on it.`,
      });
  });
}

/** Drops the records of Targets that no longer exist and of jobs their plan no longer has, unless a run is in progress. */
export function pruneJobRecords(state: RuntimeState): void {
  if (!state.jobs) return;
  const kept = state.jobs.filter((record) => {
    if (record.running) return true;
    const target = state.targets.find((t) => t.id === record.target);
    return target?.plan.jobs?.some((job) => job.name === record.job) ?? false;
  });
  if (kept.length !== state.jobs.length) state.jobs = kept;
}

/** The Activity entry of a run that ended. */
function jobActivity(
  state: Pick<RuntimeState, "projects">,
  target: Pick<TargetRecord, "projectId" | "name">,
  job: string,
  run: JobRun,
): OperationRecord {
  return {
    id: run.id,
    projectId: target.projectId,
    project: projectName(state, target),
    target: target.name,
    component: { kind: "job", name: job },
    action: run.trigger === "restore" ? "restore" : "job",
    outcome:
      run.outcome === "succeeded"
        ? "succeeded"
        : run.outcome === "stopped"
          ? "stopped"
          : "failed",
    occurredAt: run.finishedAt ?? run.startedAt,
    message: `${job}: ${describeRun(run)}`,
  };
}
function projectName(
  state: Pick<RuntimeState, "projects">,
  target: Pick<TargetRecord, "projectId">,
): string | undefined {
  return state.projects.find((project) => project.id === target.projectId)
    ?.name;
}
/** One line about how a run ended, for Activity and status: `succeeded in 3m12s`, `failed in 41s: exit 1`. */
export function describeRun(run: JobRun): string {
  const took =
    run.finishedAt !== undefined
      ? ` in ${formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}`
      : "";
  const exit =
    run.signal !== undefined
      ? `signal ${run.signal}`
      : run.exitCode !== undefined
        ? `exit ${run.exitCode}`
        : "";
  const skipped = run.skipped
    ? `; skipped ${run.skipped} scheduled ${run.skipped === 1 ? "time" : "times"} while it ran`
    : "";
  const trigger = run.trigger === "manual" ? " (rig run)" : "";
  // A restore says which backup it read; a backup run that succeeded, which backup it kept.
  const subject = run.restore ? `restore from ${run.restore.id} ` : "";
  // Said as the run's end decided it: a deletion is queued in that write and carried out after it, so it may still wait.
  const kept = run.backup?.lost
    ? "; it left no backup directory, so none was kept"
    : run.backup && run.outcome === "succeeded"
      ? `; kept backup ${run.backup.id}`
      : run.backup && run.outcome
        ? madeBackupDirectory(run)
          ? "; its backup directory was queued for deletion"
          : "; its backup directory was left in place, as Rig cannot tell that this run made it"
        : "";
  return `${subject}${outcomeText()}${kept}`;
  function outcomeText(): string {
    switch (run.outcome) {
      case "succeeded":
        return `succeeded${took}${trigger}${skipped}`;
      case "failed":
        return `failed${took}${exit ? `: ${exit}` : ""}${trigger}${skipped}`;
      case "timed-out":
        return `timed out${took} and was stopped${trigger}${skipped}`;
      case "stopped":
        return `stopped by Rig${took} (rig down, a Preview destroy, or the Target turned off)${trigger}${skipped}`;
      case "start-failed":
        return `could not start: ${run.errorCode ?? "unknown error"}${trigger}`;
      case "unknown":
        return `ended${took} with no recorded exit: the Mac restarted, or its exit record was lost${trigger}${skipped}`;
      default:
        return `running since ${run.startedAt}${trigger}`;
    }
  }
}
/** "41s", "3m12s", "2h05m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** What one scheduler pass learned that a new rigd must know: when it first saw a job, and a time it passed over because
 * the Target was not meant to run it. */
export interface SchedulingFact {
  target: string;
  job: string;
  /** ISO 8601. */
  watchedFrom?: string;
  /** ISO 8601. */
  passedOver?: string;
}
/** Records each fact on its job's record: a first sighting only once, and a time passed over only when it is later than the
 * last time acted on. */
export function recordScheduling(
  state: RuntimeState,
  facts: readonly SchedulingFact[],
): void {
  for (const fact of facts) {
    const record = ensureJobRecord(state, fact.target, fact.job);
    if (fact.watchedFrom !== undefined) record.watchedFrom ??= fact.watchedFrom;
    if (fact.passedOver !== undefined) handledTime(record, fact.passedOver);
  }
}
/** Records `at` (ISO) as a scheduled time handled: among the latest JOB_HANDLED_LIMIT handled, and as `lastScheduled`
 * unless a later time is. */
function handledTime(record: JobRecord, at: string): void {
  if (
    record.lastScheduled === undefined ||
    Date.parse(record.lastScheduled) < Date.parse(at)
  )
    record.lastScheduled = at;
  const handled = (record.handled ?? []).filter((time) => time !== at);
  record.handled = [...handled, at].slice(-JOB_HANDLED_LIMIT);
}
/** The scheduled times `record` says were handled, in Unix milliseconds: what the scheduler and status both skip. */
export function handledTimes(
  record: Pick<JobRecord, "handled" | "lastScheduled"> | undefined,
): ReadonlySet<number> {
  const times = [...(record?.handled ?? [])];
  if (record?.lastScheduled) times.push(record.lastScheduled);
  return new Set(times.map((at) => Date.parse(at)));
}
