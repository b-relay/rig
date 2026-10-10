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
import type { StopControl, TargetLifecycle } from "./lifecycle";

/* Every function here that changes a run, or signals its process, is called by an Operation that holds the run's Target
 * (rig run, rig down, a scheduled start or settlement, a destroy, rigd's first pass), so no other start or stop of the
 * job's one process key can interleave. A run is recorded before its process starts, a decision to stop it before its
 * stop signal, and a checkout it kept in the same write as its end, so a rigd that stops at any step finds what is left. */

/** What a job run needs from the runtime around it. */
export interface JobRunDependencies {
  store: Pick<StateStore, "read" | "update">;
  lifecycle: Pick<TargetLifecycle, "startJob" | "observeJob" | "stopJob">;
  /** ISO timestamp. */
  now(): string;
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
 * nothing recorded how it ended. */
export function endedRun(
  run: JobRun,
  observation: Pick<ProcessObservation, "incarnation" | "exitCode" | "signal">,
  at: string,
): JobRun {
  const evidence =
    observation.incarnation === run.id &&
    (observation.exitCode !== undefined || observation.signal !== undefined);
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

/** Records the end of the run `runId` of `job` from `observation`, as the record says it now (its stop decision
 * included), with its Activity entry; nothing when the record names another run by now. A checkout the run kept, one
 * its Target no longer plans from, is recorded in the same write to be given back. Resolves the ended run, if recorded. */
async function recordJobEnd(
  target: Pick<TargetRecord, "id" | "projectId" | "name">,
  job: string,
  runId: string,
  observation: ProcessObservation,
  deps: Pick<JobRunDependencies, "store" | "now">,
): Promise<JobRun | undefined> {
  let ended: JobRun | undefined;
  await deps.store.update((state) => {
    const record = findJobRecord(state, target.id, job);
    if (record?.running?.id !== runId) return;
    ended = endedRun(record.running, observation, deps.now());
    delete record.running;
    record.last = ended;
    recordActivity(state, jobActivity(state, target, job, ended));
    const current = state.targets.find((t) => t.id === target.id);
    const workspace = ended.workspace;
    if (
      workspace !== undefined &&
      workspace !== current?.plan.workspacePath &&
      workspace !== current?.recovery?.plan.workspacePath &&
      !state.jobCheckouts?.some(
        (kept) => kept.target === target.id && kept.workspace === workspace,
      )
    )
      (state.jobCheckouts ??= []).push({
        target: target.id,
        project: target.projectId,
        workspace,
      });
  });
  return ended;
}

/** How settling a run went: a process of it still runs, that cannot be told, the run ended and its end was recorded, or
 * the record names another run by now. */
export type JobSettlement = "running" | "unknown" | "settled" | "gone";
/** Settles the run `runId` of `job` when its process is gone: records how it ended. The caller holds the Target. */
export async function settleJobRun(
  target: TargetRecord,
  job: string,
  runId: string,
  deps: Pick<JobRunDependencies, "store" | "now"> & {
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
  deps: Pick<JobRunDependencies, "store" | "now"> & {
    lifecycle: Pick<TargetLifecycle, "observeJob" | "stopJob">;
  },
  stops?: StopControl,
): Promise<JobSettlement> {
  const observed = await deps.lifecycle.observeJob(target, job);
  if (observed.state === "unknown") return "unknown";
  if (observed.state === "running") {
    if (observed.incarnation !== undefined && observed.incarnation !== run.id)
      return "running";
    let decided = false;
    await deps.store.update((state) => {
      const record = findJobRecord(state, target.id, job);
      if (record?.running?.id !== run.id) return;
      record.running.stopping ??= { cause, at: deps.now() };
      decided = true;
    });
    if (!decided) return "gone";
    await deps.lifecycle.stopJob(
      target,
      {
        name: job,
        ...(run.stopTimeout !== undefined
          ? { stopTimeout: run.stopTimeout }
          : {}),
      },
      stops,
    );
  }
  return await settleJobRun(target, job, run.id, deps);
}

/** Stops every run of `target`'s jobs in progress, each within the stop_timeout it started with, and records each as
 * stopped by Rig; resolves how many ended. rig down, a Preview destroy, a Target turned off and rigd's first pass for a Target meant to be stopped
 * use it; a deploy does not, so a run finishes on the checkout it started from. The caller holds the Target. Every run is
 * attempted; the first failure is thrown once all were. */
export async function stopJobRuns(
  target: TargetRecord,
  deps: Pick<JobRunDependencies, "store" | "now"> & {
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
}

/** Starts a run of `job` on `target`, which the caller holds: a run still in progress refuses it with JOB_RUNNING (one whose
 * process is gone is settled first, a checkout it kept recorded with its end). The run is recorded before its process
 * starts, with the checkout it runs from, so a rigd that stops in between finds it and settles it and a deploy keeps that
 * checkout until it ends; a start that fails is recorded as start-failed and rethrown. Scheduled runs also record the time
 * they are for. */
export async function startJobRun(
  target: TargetRecord,
  job: PlanJob,
  request: JobRunRequest,
  deps: JobRunDependencies,
): Promise<JobRun> {
  const recorded = findJobRecord(
    await deps.store.read(),
    target.id,
    job.name,
  )?.running;
  if (recorded) {
    const settled = await settleJobRun(target, job.name, recorded.id, deps);
    if (settled === "running" || settled === "unknown")
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
  return run;
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
    if (
      fact.passedOver !== undefined &&
      (record.lastScheduled === undefined ||
        Date.parse(record.lastScheduled) < Date.parse(fact.passedOver))
    )
      record.lastScheduled = fact.passedOver;
  }
}
