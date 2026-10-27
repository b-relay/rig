import type { JobReport, JobRunReport } from "../domain/project-status";
import type {
  BackupRecord,
  JobRecord,
  JobRun,
  TargetRecord,
} from "../domain/runtime";
import { backupSummary } from "./backups";
import { rigCommand } from "../domain/rig-command";
import { describeRun, findJobRecord, handledTimes } from "./jobs";
import {
  inTransition,
  jobTimeZone,
  nextUnhandledRun,
  schedulesJobs,
  type JobClock,
} from "./job-scheduler";

/** Pure: the jobs `target`'s plan has as status reports them, from their records and the clock, and after them every run
 * still going of a job the plan no longer has (a deploy dropped it), which finishes on its earlier checkout. `on` says
 * whether rig.yaml turns the Target's role on; undefined when rig.yaml could not be read, which leaves the Target to its
 * record. Undefined when there is nothing to report. */
export function jobReports(
  target: TargetRecord,
  records: readonly JobRecord[] | undefined,
  now: number,
  clock: Pick<JobClock, "timeZone">,
  on: boolean | undefined,
  /** The kept backups rigd recorded; absent, backup jobs show none. */
  backups: readonly BackupRecord[] = [],
): JobReport[] | undefined {
  const jobs = target.plan.jobs ?? [];
  const reason =
    on === false
      ? `${target.kind} is off in rig.yaml, so its jobs are not scheduled.`
      : schedulesJobs(target)
        ? undefined
        : // Before `desired`, which during a deploy is the new Deployment's: stopped until its start completes.
          inTransition(target)
          ? `${target.name} has an unfinished deploy or transition, so its jobs are not scheduled.`
          : `${target.name} is stopped, so its jobs are not scheduled; ${rigCommand("up", { target })} schedules them again.`;
  const reports = jobs.map((job): JobReport => {
    const record = findJobRecord({ jobs: records }, target.id, job.name);
    const why =
      reason ??
      (job.scheduled === false
        ? `jobs.${job.name}.targets does not name ${target.kind}, so only rig run runs it here.`
        : undefined);
    // As the scheduler counts it: a time its record says was handled is not run again.
    const next = why
      ? undefined
      : nextUnhandledRun(job, now, handledTimes(record), clock);
    const backup = backupSummary({ backups: [...backups] }, target.id, job);
    return {
      name: job.name,
      schedule: job.schedule,
      timeZone: jobTimeZone(job, clock),
      state: record?.running ? "running" : "idle",
      scheduled: why === undefined,
      ...(next !== undefined
        ? { nextRunAt: new Date(next).toISOString() }
        : {}),
      ...(job.timeout !== undefined ? { timeout: job.timeout } : {}),
      ...(record?.running ? { running: runReport(record.running) } : {}),
      ...(record?.last ? { last: runReport(record.last) } : {}),
      ...(why ? { reason: why } : {}),
      ...(backup ? { backup } : {}),
    };
  });
  for (const record of records ?? [])
    if (
      record.target === target.id &&
      record.running &&
      !jobs.some((job) => job.name === record.job)
    )
      reports.push({
        name: record.job,
        state: "running",
        scheduled: false,
        removed: true,
        ...(record.running.timeout !== undefined
          ? { timeout: record.running.timeout }
          : {}),
        running: runReport(record.running),
        ...(record.last ? { last: runReport(record.last) } : {}),
        reason:
          "rig.yaml no longer has this job since the last deploy; this run finishes on the checkout it started in, and it is not scheduled again.",
      });
  return reports.length ? reports : undefined;
}
function runReport(run: JobRun): JobRunReport {
  return {
    trigger: run.trigger,
    ...(run.backup ? { backup: run.backup.id } : {}),
    ...(run.restore ? { restore: run.restore.id } : {}),
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
