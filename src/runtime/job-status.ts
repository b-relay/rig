import type { JobReport, JobRunReport } from "../domain/project-status";
import type { JobRecord, JobRun, TargetRecord } from "../domain/runtime";
import { targetSelector } from "../domain/target-selector";
import { describeRun, findJobRecord } from "./jobs";
import {
  jobTimeZone,
  nextJobRun,
  schedulesJobs,
  type JobClock,
} from "./job-scheduler";

/** Pure: the jobs `target`'s plan runs as status reports them, from their records and the clock. `on` says whether rig.yaml
 * turns the Target's role on; undefined when rig.yaml could not be read, which leaves the Target to its record. Undefined when
 * the plan runs no job. */
export function jobReports(
  target: TargetRecord,
  records: readonly JobRecord[] | undefined,
  now: number,
  clock: Pick<JobClock, "timeZone">,
  on: boolean | undefined,
): JobReport[] | undefined {
  const jobs = target.plan.jobs;
  if (!jobs?.length) return undefined;
  const reason =
    on === false
      ? `${target.kind} is off in rig.yaml, so its jobs are not scheduled.`
      : !schedulesJobs(target)
        ? target.desired !== "running"
          ? `${target.name} is stopped, so its jobs are not scheduled; rig up ${targetSelector(target)} schedules them again.`
          : `${target.name} has an unfinished deploy or transition, so its jobs are not scheduled.`
        : undefined;
  return jobs.map((job): JobReport => {
    const record = findJobRecord({ jobs: records }, target.id, job.name);
    const next = reason ? undefined : nextJobRun(job, now, clock);
    return {
      name: job.name,
      schedule: job.schedule,
      timeZone: jobTimeZone(job, clock),
      state: record?.running ? "running" : "idle",
      scheduled: reason === undefined,
      ...(next !== undefined
        ? { nextRunAt: new Date(next).toISOString() }
        : {}),
      ...(job.timeout !== undefined ? { timeout: job.timeout } : {}),
      ...(record?.running ? { running: runReport(record.running) } : {}),
      ...(record?.last ? { last: runReport(record.last) } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}
function runReport(run: JobRun): JobRunReport {
  return {
    trigger: run.trigger,
    ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
    startedAt: run.startedAt,
    ...(run.finishedAt
      ? {
          finishedAt: run.finishedAt,
          durationMs: Math.max(
            0,
            Date.parse(run.finishedAt) - Date.parse(run.startedAt),
          ),
        }
      : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.signal !== undefined ? { signal: run.signal } : {}),
    ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run.skipped ? { skipped: run.skipped } : {}),
    summary: describeRun(run),
  };
}
