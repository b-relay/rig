import type { PlanJob } from "../config/types";
import { recordActivity } from "../domain/activity";
import { RigError, diagnosticErrorCode } from "../domain/errors";
import type {
  JobOutcome,
  JobRecord,
  JobRun,
  OperationRecord,
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { ProcessObservation } from "../providers/contracts";
import type { TargetLifecycle } from "./lifecycle";

/** Where a job's stops are noted as they begin, so the run they end is recorded as stopped by Rig (rig down, a Preview
 * destroy, the Target turned off) rather than as an end nothing explains: stopping a process removes the exit record it
 * would otherwise leave. */
export interface JobStopMarks {
  /** A stop of `job` of the Target `targetId` begins at `at` (Unix milliseconds). */
  mark(targetId: string, job: string, at: number): void;
  /** Whether a stop of the job began at or after `since` (Unix milliseconds), the run's start. */
  stoppedSince(targetId: string, job: string, since: number): boolean;
  /** Forgets the job's mark once a run's end was recorded. */
  clear(targetId: string, job: string): void;
}
export function createJobStopMarks(): JobStopMarks {
  const marks = new Map<string, number>();
  return {
    mark(targetId, job, at) {
      marks.set(`${targetId}:${job}`, at);
    },
    stoppedSince(targetId, job, since) {
      const at = marks.get(`${targetId}:${job}`);
      return at !== undefined && at >= since;
    },
    clear(targetId, job) {
      marks.delete(`${targetId}:${job}`);
    },
  };
}

/** What a job run needs from the runtime around it. */
export interface JobRunDependencies {
  store: Pick<StateStore, "read" | "update">;
  lifecycle: Pick<TargetLifecycle, "startJob" | "observeJob">;
  /** ISO timestamp. */
  now(): string;
  /** Stops noted by the lifecycle; absent, every unexplained end is `unknown`. */
  jobStops?: JobStopMarks;
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

/** Pure: how `run` ended, from what its process left behind. An exit record for this run says it: exit 0 succeeded,
 * anything else failed. Without one, a stop Rig made (`cause`) says it; otherwise nothing recorded how it ended. */
export function endedRun(
  run: JobRun,
  observation: Pick<ProcessObservation, "incarnation" | "exitCode" | "signal">,
  at: string,
  cause?: "timed-out" | "stopped",
): JobRun {
  const evidence =
    observation.incarnation === run.id &&
    (observation.exitCode !== undefined || observation.signal !== undefined);
  const outcome: JobOutcome =
    cause === "timed-out"
      ? "timed-out"
      : evidence
        ? observation.exitCode === 0
          ? "succeeded"
          : "failed"
        : (cause ?? "unknown");
  return {
    ...run,
    finishedAt: at,
    outcome,
    ...(evidence && observation.exitCode !== undefined
      ? { exitCode: observation.exitCode }
      : {}),
    ...(evidence && observation.signal !== undefined
      ? { signal: observation.signal }
      : {}),
  };
}

/** Records that `run` of `job` ended as `ended` says, with its Activity entry, unless the record names another run by now.
 * Says whether it recorded it. */
export async function recordJobEnd(
  target: Pick<TargetRecord, "id" | "projectId" | "name">,
  job: string,
  ended: JobRun,
  deps: Pick<JobRunDependencies, "store">,
): Promise<boolean> {
  let recorded = false;
  await deps.store.update((state) => {
    const record = findJobRecord(state, target.id, job);
    if (record?.running?.id !== ended.id) return;
    delete record.running;
    record.last = ended;
    recordActivity(state, jobActivity(state, target, job, ended));
    recorded = true;
  });
  return recorded;
}

/** How settling a run went: its process still runs, cannot be told, or it ended and `ended` is what was recorded. */
export type JobSettlement =
  { state: "running" | "unknown" } | { state: "settled"; ended: JobRun };
/** Settles the run of `job` recorded as in progress when its process is gone: reads how it ended and records it. */
export async function settleJobRun(
  target: TargetRecord,
  job: string,
  run: JobRun,
  deps: Pick<JobRunDependencies, "store" | "now" | "jobStops"> & {
    lifecycle: Pick<TargetLifecycle, "observeJob">;
  },
  cause?: "timed-out",
): Promise<JobSettlement> {
  const observed = await deps.lifecycle.observeJob(target, job);
  if (observed.state !== "stopped") return { state: observed.state };
  const stoppedByRig = deps.jobStops?.stoppedSince(
    target.id,
    job,
    Date.parse(run.startedAt),
  );
  const ended = endedRun(
    run,
    observed,
    deps.now(),
    cause ?? (stoppedByRig ? "stopped" : undefined),
  );
  // The mark stays until an end is recorded, so a second settle of the same run, racing this one, reads it too.
  if (await recordJobEnd(target, job, ended, deps))
    deps.jobStops?.clear(target.id, job);
  return { state: "settled", ended };
}
/** Stops every run of `target`'s jobs in progress, each within the stop_timeout it started with, and records each as
 * stopped by Rig. rig down, a Preview destroy, and a Target turned off use it; a deploy does not, so a run finishes on the
 * checkout it started from. Returns the runs that ended, so a checkout only they still used can be given back. Every run is
 * attempted; the first failure is thrown once all were. */
export async function stopJobRuns(
  target: TargetRecord,
  deps: Pick<JobRunDependencies, "store" | "now" | "jobStops"> & {
    lifecycle: Pick<TargetLifecycle, "observeJob" | "stopJob">;
  },
  stops?: Parameters<TargetLifecycle["stopJob"]>[2],
): Promise<JobRun[]> {
  const running = ((await deps.store.read()).jobs ?? []).filter(
    (record) => record.target === target.id && record.running,
  );
  const ended: JobRun[] = [];
  const failures: unknown[] = [];
  for (const record of running) {
    const run = record.running!;
    try {
      await deps.lifecycle.stopJob(
        target,
        {
          name: record.job,
          ...(run.stopTimeout !== undefined
            ? { stopTimeout: run.stopTimeout }
            : {}),
        },
        stops,
      );
      const settled = await settleJobRun(target, record.job, run, deps);
      if (settled.state === "settled") ended.push(settled.ended);
    } catch (error) {
      failures.push(error);
    }
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
}

/** Starts a run of `job` on `target`, which the caller holds: a run still in progress refuses it with JOB_RUNNING (one whose
 * process is gone is settled first, and returned as `settled`). The run is recorded before its process starts, with the
 * checkout it runs from, so a rigd that stops in between finds it and settles it and a deploy keeps that checkout until it
 * ends; a start that fails is recorded as start-failed and rethrown. Scheduled runs also record the time they are for. */
export async function startJobRun(
  target: TargetRecord,
  job: PlanJob,
  request: JobRunRequest,
  deps: JobRunDependencies,
): Promise<{ run: JobRun; settled?: JobRun }> {
  const recorded = findJobRecord(
    await deps.store.read(),
    target.id,
    job.name,
  )?.running;
  let settled: JobRun | undefined;
  if (recorded) {
    const settlement = await settleJobRun(target, job.name, recorded, deps);
    if (settlement.state === "settled") settled = settlement.ended;
    else
      throw new RigError(
        "JOB_RUNNING",
        `${job.name} is still running on ${target.name} (started ${recorded.startedAt}).`,
        `Wait for it to finish (rig status shows it), or stop it with rig down. Runs of one job never overlap.`,
        { job: job.name, run: recorded.id, startedAt: recorded.startedAt },
      );
  }
  const run: JobRun = {
    id: request.id,
    trigger: request.trigger,
    ...(request.scheduledFor !== undefined
      ? { scheduledFor: new Date(request.scheduledFor).toISOString() }
      : {}),
    startedAt: deps.now(),
    workspace: target.plan.workspacePath,
    ...(job.timeout !== undefined ? { timeout: job.timeout } : {}),
    ...(job.stopTimeout !== undefined ? { stopTimeout: job.stopTimeout } : {}),
  };
  await deps.store.update((state) => {
    const record = ensureJobRecord(state, target.id, job.name);
    record.running = run;
    if (run.scheduledFor) record.lastScheduled = run.scheduledFor;
  });
  try {
    await deps.lifecycle.startJob(target, job, run.id);
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
        if (run.trigger === "schedule")
          recordActivity(state, jobActivity(state, target, job.name, failed));
      })
      .catch(() => {});
    throw error;
  }
  return { run, ...(settled ? { settled } : {}) };
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
    record.lastScheduled = at;
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
    action: "job",
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
/** "41s", "3m12s", "2h05m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
