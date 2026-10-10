import type { PlanJob } from "../config/types";
import { nextRun, parseCron, type CronSchedule } from "../domain/cron";
import { diagnosticErrorCode } from "../domain/errors";
import type {
  JobRecord,
  JobRun,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import {
  findJobRecord,
  pruneJobRecords,
  settleJobRun,
  type JobStopMarks,
} from "./jobs";
import type { TargetLifecycle } from "./lifecycle";

/** How often rigd looks for scheduled times that are due and runs that ended; a run starts at most this late. */
export const JOB_SCHEDULER_TICK_MS = 1000;
/** How late a scheduled time may still start. A time found later than this (the Mac slept, rigd was not running, or its
 * Target was busy that long) is dropped without a record: nothing is caught up. */
export const JOB_LATE_LIMIT_MS = 5 * 60_000;
/** How often a Target with a job run in progress is checked for rig.yaml turning its role off. */
export const JOB_OFF_CHECK_MS = 10_000;
/** How long `stop` waits for the work in flight. */
const JOB_SCHEDULER_STOP_MS = 5000;

/** The time the scheduler lives by: the wall clock and the Host's time zone in rigd, a script in tests. */
export interface JobClock {
  /** Unix milliseconds. */
  now(): number;
  /** The Host's IANA time zone, the zone of a job without `timezone`. */
  timeZone(): string;
}
/** A scheduled time due for one job of one Target. */
export interface ScheduledRunRequest {
  targetId: string;
  job: string;
  /** Unix milliseconds. */
  scheduledFor: number;
  /** The run's identity, should it start. */
  id: string;
}
/** How a scheduled time was handled: run, skipped and recorded because a run is still going, passed over because the
 * Target is not meant to run it now (nothing recorded), or deferred because rigd cannot start anything yet. */
export type ScheduledRunResult =
  "started" | "skipped" | "passed" | "deferred" | "failed";
export interface JobSchedulerDependencies {
  store: Pick<StateStore, "read" | "update">;
  lifecycle: Pick<TargetLifecycle, "observeJob" | "stopJob">;
  clock: JobClock;
  id(): string;
  /** Whether an Operation holds or waits for the Target, so a run of it may be starting or stopping. */
  busy(target: TargetRecord): boolean;
  /** Runs a due time as an Operation on its Target: waits for the Target like any command, checks it is still meant to run
   * the job, and starts a run, or records the time skipped while a run is still going. Never rejects. */
  start(request: ScheduledRunRequest): Promise<ScheduledRunResult>;
  /** Gives back a checkout of the Target a deploy kept for a run that has ended, once nothing uses it. Never rejects. */
  releaseRevision(targetId: string, workspace: string): Promise<void>;
  /** Stops the Target's runs in progress when rig.yaml turns its role off. Never rejects. */
  stopJobsIfOff(targetId: string): Promise<void>;
  jobStops?: JobStopMarks;
  diagnostic: RuntimeDependencies["diagnostic"];
}
export interface JobScheduler {
  /** Settles the runs that ended, stops the ones past their timeout, and hands every due time to `start`, then returns
   * without waiting for that work. */
  pass(): Promise<void>;
  /** Resolves once the work started so far has settled. */
  idle(): Promise<void>;
  /** Ends the scheduler: nothing new starts, and it resolves once the work in flight settled or a bound passed. */
  stop(): Promise<void>;
}

/** Whether a recorded Target runs its jobs on schedule now: deployed completely, meant to run, and in no transition. Whether
 * rig.yaml still turns its role on is checked when a run starts. */
export function schedulesJobs(target: TargetRecord): boolean {
  return (
    target.desired === "running" &&
    !target.recovery &&
    !target.destructionPending &&
    !target.deploymentIncomplete
  );
}
/** The zone `job` is scheduled in: its own, or the Host's. */
export function jobTimeZone(
  job: Pick<PlanJob, "timeZone">,
  clock: Pick<JobClock, "timeZone">,
): string {
  return job.timeZone ?? clock.timeZone();
}
const schedules = new Map<string, CronSchedule | undefined>();
/** The parsed schedule of `job`; undefined for an expression this rigd cannot read (a plan validated by another version). */
export function jobSchedule(
  job: Pick<PlanJob, "schedule">,
): CronSchedule | undefined {
  if (!schedules.has(job.schedule)) {
    const parsed = parseCron(job.schedule);
    schedules.set(job.schedule, "problem" in parsed ? undefined : parsed);
  }
  return schedules.get(job.schedule);
}
/** When `job` next runs after `after` (Unix milliseconds), or undefined when its schedule names no time. */
export function nextJobRun(
  job: Pick<PlanJob, "schedule" | "timeZone">,
  after: number,
  clock: Pick<JobClock, "timeZone">,
): number | undefined {
  const schedule = jobSchedule(job);
  return schedule && nextRun(schedule, after, jobTimeZone(job, clock));
}

/** rigd's job scheduler. Each pass reads the recorded Targets and job runs:
 * - the latest scheduled time of a job that came due since the last pass (within JOB_LATE_LIMIT_MS) is handed to `start`,
 *   which runs it, or records it skipped while a run still goes; earlier ones, and ones of a Target not meant to run, pass
 *   without a record;
 * - a run recorded in progress whose process is gone is settled (its exit recorded, with its Activity entry), and one past
 *   its timeout is stopped and recorded as timed out; neither while an Operation holds the Target, which may be starting
 *   or stopping it. A run a deploy left on its earlier checkout is settled too, and that checkout given back;
 * - a Target with a run in progress whose role rig.yaml turns off has its runs stopped.
 * Which times were handled lives in memory, seeded from each record's `lastScheduled`, so a new rigd never runs a time
 * twice and runs one it missed by less than the late limit. Work for one job never overlaps. */
export function createJobScheduler(
  deps: JobSchedulerDependencies,
): JobScheduler {
  /** The latest time handled (or passed over) per `<target id>:<job>`, Unix milliseconds. */
  const watermarks = new Map<string, number>();
  /** When each Target with a run in progress was last checked for an off switch, Unix milliseconds. */
  const offChecks = new Map<string, number>();
  const inFlight = new Set<string>();
  const work = new Set<Promise<void>>();
  let stopped = false;
  const idle = async () => {
    while (work.size) await Promise.allSettled([...work]);
  };
  /** What settling a run needs: the store, the observation, and the clock as an ISO timestamp. */
  const runDeps = {
    store: deps.store,
    lifecycle: deps.lifecycle,
    now: () => new Date(deps.clock.now()).toISOString(),
    ...(deps.jobStops ? { jobStops: deps.jobStops } : {}),
  };
  const dispatch = (
    key: string,
    label: string,
    target: TargetRecord,
    task: () => Promise<void>,
  ) => {
    inFlight.add(key);
    const job = task()
      .catch(async (error: unknown) => {
        await deps
          .diagnostic({
            operationId: deps.id(),
            action: label,
            outcome: "failed",
            target: target.name,
            errorCode: diagnosticErrorCode(error),
          })
          .catch(() => {});
      })
      .finally(() => inFlight.delete(key));
    work.add(job);
    void job.finally(() => work.delete(job));
  };
  /** Where the times of a job first seen count from: the last one a rigd handled, but never more than the late limit
   * back, or now for a job that has never been scheduled or run. */
  const seed = (record: JobRecord | undefined, now: number): number => {
    if (!record) return now;
    const last = record.lastScheduled
      ? Date.parse(record.lastScheduled)
      : -Infinity;
    return Math.max(last, now - JOB_LATE_LIMIT_MS);
  };
  /** The latest scheduled time due now that has not been handled, or undefined. Times older than the late limit are
   * dropped here, so a long sleep runs at most the one time that came due within the limit. */
  const due = (
    key: string,
    job: PlanJob,
    record: JobRecord | undefined,
    now: number,
  ) => {
    const from = Math.max(
      watermarks.get(key) ?? seed(record, now),
      now - JOB_LATE_LIMIT_MS,
    );
    watermarks.set(key, from);
    let latest: number | undefined;
    for (
      let at = nextJobRun(job, from, deps.clock);
      at !== undefined && at <= now;
      at = nextJobRun(job, at, deps.clock)
    )
      latest = at;
    return latest;
  };
  return {
    idle,
    async stop() {
      stopped = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        idle(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, JOB_SCHEDULER_STOP_MS);
        }),
      ]);
      clearTimeout(timer);
    },
    async pass() {
      if (stopped) return;
      const state = await deps.store.read();
      if (stopped) return;
      const now = deps.clock.now();
      const planned = new Set<string>();
      /** Settles a run whose process is gone, or stops one past its timeout and records it timed out, and gives back a
       * checkout a deploy kept only for it. */
      const settle = (target: TargetRecord, job: string, run: JobRun) => {
        const key = `${target.id}:${job}`;
        const deadline =
          run.timeout === undefined
            ? undefined
            : Date.parse(run.startedAt) + run.timeout * 1000;
        const late = deadline !== undefined && now >= deadline;
        dispatch(key, late ? "job-timeout" : "job", target, async () => {
          // Timed out only when this stop ended it: a run that exited on its own before the check keeps its own exit.
          const timedOut =
            late &&
            (
              await deps.lifecycle.stopJob(target, {
                name: job,
                ...(run.stopTimeout !== undefined
                  ? { stopTimeout: run.stopTimeout }
                  : {}),
              })
            ).outcome === "stopped";
          const settled = await settleJobRun(
            target,
            job,
            run,
            runDeps,
            timedOut ? "timed-out" : undefined,
          );
          // The runtime checks again, under the Target's lease, that nothing uses the checkout any more.
          if (settled.state === "settled" && settled.ended.workspace)
            await deps.releaseRevision(target.id, settled.ended.workspace);
        });
      };
      for (const target of state.targets)
        for (const job of target.plan.jobs ?? []) {
          const key = `${target.id}:${job.name}`;
          planned.add(key);
          if (inFlight.has(key)) continue;
          const record = findJobRecord(state, target.id, job.name);
          const running = record?.running;
          const runningPastTimeout =
            running?.timeout !== undefined &&
            now >= Date.parse(running.startedAt) + running.timeout * 1000;
          // A start or stop under the Target's lock may be under way; the next free pass looks again.
          if (running && runningPastTimeout && !deps.busy(target)) {
            settle(target, job.name, running);
            continue;
          }
          const scheduledFor = due(key, job, record, now);
          if (scheduledFor !== undefined) {
            const before = watermarks.get(key)!;
            watermarks.set(key, scheduledFor);
            // A Target not meant to run lets its times pass, unrecorded.
            if (schedulesJobs(target)) {
              // The start settles a run that ended, or records the time skipped while it still goes.
              dispatch(key, "job", target, async () => {
                const result = await deps.start({
                  targetId: target.id,
                  job: job.name,
                  scheduledFor,
                  id: deps.id(),
                });
                // Nothing could start yet: the time stays due until the late limit.
                if (result === "deferred") watermarks.set(key, before);
              });
              continue;
            }
          }
          if (running && !deps.busy(target)) settle(target, job.name, running);
        }
      // A run of a job its Target's plan no longer has (a deploy removed it) still ends on its own checkout and is settled.
      for (const record of state.jobs ?? []) {
        const key = `${record.target}:${record.job}`;
        if (!record.running || planned.has(key) || inFlight.has(key)) continue;
        const target = state.targets.find((t) => t.id === record.target);
        if (target && !deps.busy(target))
          settle(target, record.job, record.running);
      }
      // rig.yaml turning a Target's role off stops its runs, as rig down would; checked every JOB_OFF_CHECK_MS.
      for (const targetId of new Set(
        (state.jobs ?? [])
          .filter((record) => record.running)
          .map((record) => record.target),
      )) {
        const key = `off:${targetId}`;
        const target = state.targets.find((t) => t.id === targetId);
        if (
          !target ||
          inFlight.has(key) ||
          now - (offChecks.get(targetId) ?? -Infinity) < JOB_OFF_CHECK_MS
        )
          continue;
        offChecks.set(targetId, now);
        dispatch(key, "job-off", target, () => deps.stopJobsIfOff(targetId));
      }
      for (const targetId of offChecks.keys())
        if (!state.jobs?.some((r) => r.running && r.target === targetId))
          offChecks.delete(targetId);
      for (const key of watermarks.keys())
        if (!planned.has(key)) watermarks.delete(key);
      if (
        state.jobs?.some(
          (record) =>
            !record.running &&
            !state.targets.some(
              (target) =>
                target.id === record.target &&
                target.plan.jobs?.some((job) => job.name === record.job),
            ),
        )
      )
        await deps.store.update(pruneJobRecords);
    },
  };
}
