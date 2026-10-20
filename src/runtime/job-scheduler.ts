import type { PlanJob } from "../config/types";
import { nextRun, parseCron, type CronSchedule } from "../domain/cron";
import { diagnosticErrorCode } from "../domain/errors";
import type {
  JobRecord,
  JobRun,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { RuntimeDependencies, WorkReport } from "./contracts";
import {
  findJobRecord,
  pastTimeout,
  pruneJobRecords,
  recordScheduling,
  type SchedulingFact,
} from "./jobs";
import { trackedWorkReport } from "./work-report";
import { backupWorkPending } from "./backups";
import type { TargetLifecycle } from "./lifecycle";

/** How often rigd looks for scheduled times that are due and runs that ended; a run starts at most this late. */
export const JOB_SCHEDULER_TICK_MS = 1000;
/** How late a scheduled time may still start. A time found later than this (the Mac slept, rigd was not running, or its
 * Target was busy that long) is dropped without a record: nothing is caught up. */
export const JOB_LATE_LIMIT_MS = 5 * 60_000;
/** How often a Target with a job run in progress is checked for rig.yaml turning its role off. */
export const JOB_OFF_CHECK_MS = 10_000;
/** How often a held checkout (one a job run or a kept Service ran in) is offered back again while it cannot be given back yet. */
export const JOB_CHECKOUT_RETRY_MS = 30_000;
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
 * Target is not meant to run it now (nothing recorded), deferred because rigd cannot start anything yet, or failed: its run
 * could not start, which its record and Activity say (start-failed). */
export type ScheduledRunResult =
  "started" | "skipped" | "passed" | "deferred" | "failed";
/** A run the scheduler saw ended or past its timeout, for the runtime to settle under the Target's lease. */
export interface JobSettleRequest {
  targetId: string;
  job: string;
  /** The run the scheduler judged; a record naming another run by then is left alone. */
  runId: string;
}
export interface JobSchedulerDependencies {
  store: Pick<StateStore, "read" | "update">;
  /** Observes a run's process without holding its Target, only to decide whether the runtime needs to act. */
  lifecycle: Pick<TargetLifecycle, "observeJob">;
  clock: JobClock;
  id(): string;
  /** Whether an Operation holds or waits for the Target, so a run of it may be starting or stopping. */
  busy(target: TargetRecord): boolean;
  /** Runs a due time as an Operation on its Target: waits for the Target like any command, checks it is still meant to run
   * the job, and starts a run, or records the time skipped while a run is still going. Rejects when that could not be done
   * or recorded. */
  start(request: ScheduledRunRequest): Promise<ScheduledRunResult>;
  /** Under the Target's lease, reads the run again and, when it is still the one judged, records its end, or stops it past
   * its timeout and records it timed out. Rejects when that could not be done. */
  settle(request: JobSettleRequest): Promise<void>;
  /** Stops a run past its timeout while an Operation holds its Target, without its lease: only that run's own process is
   * signalled, and its end is left to `settle` once the Target is free. Rejects when that could not be done. */
  enforceDeadline(request: JobSettleRequest): Promise<void>;
  /** Gives back the Target's held checkouts (of job runs and kept Services) once nothing runs in them. Rejects when that
   * could not be done; `skipped` when it was not tried (an Operation held the Target), so it is offered again at once. */
  releaseCheckouts(targetId: string): Promise<void | "skipped">;
  /** Stops the Target's runs in progress when rig.yaml turns its role off. Rejects when that could not be done. */
  stopJobsIfOff(targetId: string): Promise<void>;
  /** Measures backups left without a size and deletes the backup directories queued for deletion; absent where no job
   * keeps backups. Rejects when the state cannot be read. */
  tidyBackups?(): Promise<void>;
  diagnostic: RuntimeDependencies["diagnostic"];
  /** Where each piece of the scheduler's work (by its key: `<target id>:<job>`, `deadline:<target id>:<job>:<run id>`,
   * `off:<target id>`, `checkout:<target id>`, `backups`) says it failed, and later that it succeeded or is no longer
   * needed. */
  report: WorkReport;
}
export interface JobScheduler {
  /** Hands every due time to `start`, every run that ended or is past its timeout to `settle`, and every kept checkout to
   * `releaseCheckouts`, then returns without waiting for that work. */
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
export { pastTimeout };

/** rigd's job scheduler. It reads state and observes processes but changes neither: whatever it finds is handed to the
 * runtime, which acts under the Target's lease. Each pass reads the recorded Targets, job runs and kept checkouts:
 * - the latest scheduled time of a job its Target's schedule runs that came due since the last pass (within
 *   JOB_LATE_LIMIT_MS) goes to `start`, which runs it, or records it skipped while a run still goes; earlier ones are
 *   dropped, and a Target not meant to run passes them over, recording only that it did;
 * - a run recorded in progress whose process is gone, or which is past its timeout, goes to `settle`, never while an
 *   Operation holds the Target, which may be starting or stopping it; a run a deploy left on its earlier checkout, or of a
 *   job the new plan dropped, too. A run past its timeout while an Operation holds the Target goes to `enforceDeadline`,
 *   which stops its process then, so no Operation extends its limit, and `settle` records its end once the Target is free;
 * - a held checkout (a job run's or a kept Service's) goes to `releaseCheckouts`, again every JOB_CHECKOUT_RETRY_MS while it stays;
 * - a Target with a run in progress goes to `stopJobsIfOff` every JOB_OFF_CHECK_MS.
 * Which times were handled lives in memory, seeded from each record's `lastScheduled`, or its `watchedFrom` (written the
 * first time a job is seen), so a new rigd never runs a time twice and runs one it missed by less than the late limit. Work
 * for one job never overlaps. Each piece of work that fails is reported under its key until work under that key succeeds,
 * or the key leaves what the scheduler looks after (its job leaves the plan with no run left, say). */
export function createJobScheduler(
  deps: JobSchedulerDependencies,
): JobScheduler {
  /** The latest time handled (or passed over) per `<target id>:<job>`, Unix milliseconds. */
  const watermarks = new Map<string, number>();
  /** When each Target with a run in progress was last checked for an off switch, Unix milliseconds. */
  const offChecks = new Map<string, number>();
  /** When each Target's kept checkouts were last offered back, Unix milliseconds. */
  const checkoutOffers = new Map<string, number>();
  /** When queued backup directories were last offered for deletion, Unix milliseconds. */
  let backupOffer = -Infinity;
  const inFlight = new Set<string>();
  const work = new Set<Promise<void>>();
  const report = trackedWorkReport(deps.report);
  let stopped = false;
  const idle = async () => {
    while (work.size) await Promise.allSettled([...work]);
  };
  /** Runs `task` as the work `key`, reported under it: `about` names it to the operator. A task that found nothing to do
   * (`skipped`) neither failed nor succeeded. */
  const dispatch = (
    key: string,
    label: string,
    target: string,
    about: string,
    task: () => Promise<void | "skipped">,
  ) => {
    inFlight.add(key);
    const job = task()
      .then(
        (done) => {
          if (done !== "skipped") report.succeeded(key);
        },
        async (error: unknown) => {
          report.failed(key, about, error);
          await deps
            .diagnostic({
              operationId: deps.id(),
              action: label,
              outcome: "failed",
              target,
              errorCode: diagnosticErrorCode(error),
            })
            .catch(() => {});
        },
      )
      .finally(() => inFlight.delete(key));
    work.add(job);
    void job.finally(() => work.delete(job));
  };
  /** Where the times of a job count from when this rigd first meets it: the last one acted on, else when a rigd first saw
   * the job, but never more than the late limit back. */
  const seed = (record: JobRecord | undefined, now: number): number => {
    const from = record?.lastScheduled ?? record?.watchedFrom;
    return Math.max(from ? Date.parse(from) : now, now - JOB_LATE_LIMIT_MS);
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
      const at = new Date(now).toISOString();
      const planned = new Set<string>();
      const facts: SchedulingFact[] = [];
      /** Hands a run that may have ended, or is past its timeout, to the runtime; the process is observed first, unlocked,
       * so a run that simply goes on costs no lease. Never while an Operation holds the Target: the deadline watch below
       * stops a run past its timeout then. */
      const settle = (target: TargetRecord, job: string, run: JobRun) => {
        if (deps.busy(target)) return;
        dispatch(
          `${target.id}:${job}`,
          "job",
          target.name,
          `Recording the end of the run of ${job} on ${target.name} of ${target.plan.project}`,
          async () => {
            const seen = await deps.lifecycle.observeJob(target, job);
            if (seen.state === "running" && !pastTimeout(run, deps.clock.now()))
              return "skipped";
            await deps.settle({ targetId: target.id, job, runId: run.id });
          },
        );
      };
      for (const target of state.targets)
        for (const job of target.plan.jobs ?? []) {
          const key = `${target.id}:${job.name}`;
          planned.add(key);
          if (inFlight.has(key)) continue;
          const record = findJobRecord(state, target.id, job.name);
          const running = record?.running;
          // Only rig run runs a job its targets do not name for this Target.
          if (job.scheduled === false) {
            if (running) settle(target, job.name, running);
            continue;
          }
          // Seen for the first time: a new rigd counts this job's times from now, not from when it first runs.
          if (!record?.watchedFrom && !record?.lastScheduled)
            facts.push({ target: target.id, job: job.name, watchedFrom: at });
          const scheduledFor = due(key, job, record, now);
          if (scheduledFor !== undefined) {
            const before = watermarks.get(key)!;
            watermarks.set(key, scheduledFor);
            if (!schedulesJobs(target)) {
              // A Target not meant to run passes its times over, and records it, so a later restart never runs one.
              facts.push({
                target: target.id,
                job: job.name,
                passedOver: new Date(scheduledFor).toISOString(),
              });
            } else {
              // The start settles a run that ended, or records the time skipped while it still goes.
              dispatch(
                key,
                "job",
                target.name,
                `Starting the run of ${job.name} scheduled for ${new Date(scheduledFor).toISOString()} on ${target.name} of ${target.plan.project}`,
                async () => {
                  const result = await deps.start({
                    targetId: target.id,
                    job: job.name,
                    scheduledFor,
                    id: deps.id(),
                  });
                  // Nothing could start yet: the time stays due until the late limit.
                  if (result === "deferred") watermarks.set(key, before);
                },
              );
              continue;
            }
          }
          if (running) settle(target, job.name, running);
        }
      // A run of a job its Target's plan no longer has (a deploy removed it) still ends on its own checkout and is settled.
      for (const record of state.jobs ?? []) {
        const key = `${record.target}:${record.job}`;
        if (!record.running || planned.has(key) || inFlight.has(key)) continue;
        const target = state.targets.find((t) => t.id === record.target);
        if (target) settle(target, record.job, record.running);
      }
      // The deadline watch: a run past its timeout while an Operation holds its Target is stopped now, whatever else of its
      // job is in flight (a start or settlement waiting for that Operation), so nothing queued on the Target extends its
      // limit. Its own key, so it never waits behind that work either.
      for (const record of state.jobs ?? []) {
        const run = record.running;
        // Keyed by the run: its failure is about that run alone, and goes once the run is gone.
        const key = `deadline:${record.target}:${record.job}:${run?.id}`;
        const target = state.targets.find((t) => t.id === record.target);
        if (
          !run ||
          !target ||
          inFlight.has(key) ||
          !deps.busy(target) ||
          !pastTimeout(run, now)
        )
          continue;
        dispatch(
          key,
          "job",
          target.name,
          `Stopping the run of ${record.job} on ${target.name} of ${target.plan.project} past its timeout`,
          async () => {
            const seen = await deps.lifecycle.observeJob(target, record.job);
            if (seen.state !== "running") return "skipped";
            await deps.enforceDeadline({
              targetId: target.id,
              job: record.job,
              runId: run.id,
            });
          },
        );
      }
      // rig.yaml turning a Target's role off stops its runs, as rig down would; checked every JOB_OFF_CHECK_MS.
      const withRuns = new Set(
        (state.jobs ?? [])
          .filter((record) => record.running)
          .map((record) => record.target),
      );
      for (const targetId of withRuns) {
        const key = `off:${targetId}`;
        const target = state.targets.find((t) => t.id === targetId);
        if (
          !target ||
          inFlight.has(key) ||
          now - (offChecks.get(targetId) ?? -Infinity) < JOB_OFF_CHECK_MS
        )
          continue;
        offChecks.set(targetId, now);
        dispatch(
          key,
          "job-off",
          target.name,
          `Checking whether rig.yaml turned ${target.name} of ${target.plan.project} off, to stop its runs`,
          () => deps.stopJobsIfOff(targetId),
        );
      }
      for (const targetId of offChecks.keys())
        if (!withRuns.has(targetId)) offChecks.delete(targetId);
      // Held checkouts (of job runs and kept Services) are offered back until they are gone, by this rigd or the next.
      const keeping = new Set(
        (state.heldCheckouts ?? []).map((kept) => kept.target),
      );
      for (const targetId of keeping) {
        const key = `checkout:${targetId}`;
        if (
          inFlight.has(key) ||
          now - (checkoutOffers.get(targetId) ?? -Infinity) <
            JOB_CHECKOUT_RETRY_MS
        )
          continue;
        checkoutOffers.set(targetId, now);
        dispatch(
          key,
          "held-checkout",
          targetId,
          `Giving back the checkouts a run or a kept Service held for ${state.targets.find((t) => t.id === targetId)?.name ?? targetId}`,
          async () => {
            const done = await deps.releaseCheckouts(targetId);
            // Not tried: offered again at the next pass, not in JOB_CHECKOUT_RETRY_MS.
            if (done === "skipped") checkoutOffers.delete(targetId);
            return done;
          },
        );
      }
      for (const targetId of checkoutOffers.keys())
        if (!keeping.has(targetId)) checkoutOffers.delete(targetId);
      // Backup directories queued for deletion, and backups left without a size, are offered again until done, by this rigd or the next.
      if (
        deps.tidyBackups &&
        backupWorkPending(state) &&
        !inFlight.has("backups") &&
        now - backupOffer >= JOB_CHECKOUT_RETRY_MS
      ) {
        backupOffer = now;
        dispatch(
          "backups",
          "backup-tidy",
          "",
          "Measuring and deleting backups",
          deps.tidyBackups,
        );
      }
      // A failure of work the scheduler no longer looks after (its job left the plan with no run left, its Target is gone,
      // nothing is held or queued any more) no longer stands.
      report.only(
        (key) =>
          planned.has(key) ||
          inFlight.has(key) ||
          state.jobs?.some(
            (record) =>
              record.running &&
              (`${record.target}:${record.job}` === key ||
                `deadline:${record.target}:${record.job}:${record.running.id}` ===
                  key),
          ) ||
          (key.startsWith("off:") && withRuns.has(key.slice(4))) ||
          (key.startsWith("checkout:") && keeping.has(key.slice(9))) ||
          (key === "backups" && backupWorkPending(state)),
      );
      for (const key of watermarks.keys())
        if (!planned.has(key)) watermarks.delete(key);
      const prunable = state.jobs?.some(
        (record) =>
          !record.running &&
          !state.targets.some(
            (target) =>
              target.id === record.target &&
              target.plan.jobs?.some((job) => job.name === record.job),
          ),
      );
      if (facts.length || prunable)
        await deps.store.update((current) => {
          recordScheduling(current, facts);
          pruneJobRecords(current);
        });
    },
  };
}
