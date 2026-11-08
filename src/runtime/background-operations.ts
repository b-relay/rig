import { targetOn } from "../config/target-roles";
import { clockOr } from "../domain/clock";
import {
  RigError,
  diagnosticCauses,
  diagnosticErrorCode,
} from "../domain/errors";
import type { OperationPhase } from "../domain/operation-progress";
import type { TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { restartForHealth } from "./health-restart";
import type {
  HealthRestartRequest,
  HealthRestartResult,
} from "./health-monitor";
import {
  JOB_LATE_LIMIT_MS,
  schedulesJobs,
  type JobSettleRequest,
  type ScheduledRunRequest,
  type ScheduledRunResult,
} from "./job-scheduler";
import {
  enforceJobDeadline,
  findJobRecord,
  recordScheduling,
  recordSkippedRun,
  settleJobRun,
  startJobRun,
  stopJobRun,
  stopJobRuns,
} from "./jobs";
import type { TargetLifecycle } from "./lifecycle";
import type { OperationCoordinator } from "./operation-coordinator";
import { checkoutConfig } from "./projects";
import {
  forgetReleasedCheckouts,
  releaseHeldCheckouts,
  revisionStanding,
} from "./revisions";
import type { HostRestartRecords } from "./supervision-passes";

/** What rigd starts on its own for a Target, each as an Operation under the Target's lease, listed like a command; see
 * `RigRuntime` for each one's contract. */
export interface BackgroundOperations {
  restartUnhealthy(request: HealthRestartRequest): Promise<HealthRestartResult>;
  runScheduledJob(request: ScheduledRunRequest): Promise<ScheduledRunResult>;
  settleJob(request: JobSettleRequest): Promise<void>;
  enforceJobDeadline(request: JobSettleRequest): Promise<void>;
  stopJobsIfOff(targetId: string): Promise<void>;
  releaseHeldCheckouts(targetId: string): Promise<void | "skipped">;
}
export function createBackgroundOperations(
  deps: RuntimeDependencies,
  coordinator: Pick<
    OperationCoordinator,
    | "detach"
    | "draining"
    | "gate"
    | "lifecycleOf"
    | "onTarget"
    | "targetBusy"
    | "track"
  >,
  restartRecords: HostRestartRecords,
): BackgroundOperations {
  /** Runs `work` on the recorded Target `targetId` under its lease, as rigd's own Operation `action`; undefined when the
   * Target is gone or rigd is draining. A failure goes to the diagnostic log, and rejects. */
  const onTarget = async (
    targetId: string,
    action: string,
    work: (target: TargetRecord, lifecycle: TargetLifecycle) => Promise<void>,
    /** What status shows it doing while it holds the Target. */
    phase: OperationPhase = "stopping",
  ): Promise<void> => {
    if (coordinator.draining()) return;
    const recorded = (await deps.store.read()).targets.find(
      (target) => target.id === targetId,
    );
    if (!recorded) return;
    const operationId = `${action}:${deps.id()}`;
    await coordinator.onTarget(
      recorded,
      { operationId, action, phase },
      undefined,
      async (entry) => {
        try {
          const target = (await deps.store.read()).targets.find(
            (t) => t.id === targetId,
          );
          // Its stops are detached on shutdown and shown as stopping, as a command's are.
          if (target) await work(target, coordinator.lifecycleOf(entry));
        } catch (error) {
          await deps
            .diagnostic({
              operationId,
              action,
              outcome: "failed",
              target: recorded.name,
              errorCode: diagnosticErrorCode(error),
              ...diagnosticCauses(error),
            })
            .catch(() => {});
          throw error;
        }
      },
    );
  };
  return {
    /** A health restart: an Operation on one Target, listed like a command so status shows its stop. */
    async restartUnhealthy(request) {
      if (coordinator.draining()) return { outcome: "skipped" };
      const recorded = (await deps.store.read()).targets.find(
        (target) => target.id === request.targetId,
      );
      if (!recorded) return { outcome: "skipped" };
      const operationId = `health:${deps.id()}`;
      return await coordinator.onTarget<HealthRestartResult>(
        recorded,
        { operationId, action: "health-restart", phase: "restarting" },
        { outcome: "skipped" },
        async (entry) => {
          try {
            const state = await deps.store.read();
            const target = state.targets.find((t) => t.id === request.targetId);
            if (
              !target ||
              target.desired !== "running" ||
              target.recovery ||
              target.destructionPending
            )
              return { outcome: "skipped" as const };
            // Nothing starts until rigd has reconciled the Host session (the coordinator's gate).
            if (coordinator.gate.closed())
              return { outcome: "deferred" as const };
            // A failed start after a Host restart this daemon could not record yet is recorded before anything acts on the
            // Target, as a supervision pass and an admitted command do; the monitor asks again and judges what is recorded then.
            if (restartRecords.failedStartPending(target.id)) {
              await restartRecords.recordFailedStart(target);
              return { outcome: "deferred" as const };
            }
            // So is a working Target's or Preview's stop by a Host restart: until it is recorded, which holds its Services
            // stopped until rig up, nothing is restarted or started for health; the next supervision pass records it.
            if (!(await restartRecords.recordStop(target)))
              return { outcome: "deferred" as const };
            const project = state.projects.find(
              (p) => p.id === target.projectId,
            );
            if (project) entry.view.project = project.name;
            return await restartForHealth(
              target,
              request,
              { ...deps, lifecycle: coordinator.lifecycleOf(entry) },
              (phase) => {
                entry.view.phase = phase;
              },
            );
          } catch (error) {
            await deps
              .diagnostic({
                operationId,
                action: "health-restart",
                outcome: "failed",
                target: recorded.name,
                errorCode: diagnosticErrorCode(error),
                ...diagnosticCauses(error),
              })
              .catch(() => {});
            const clock = clockOr(deps.clock, deps.now);
            return {
              outcome: "failed" as const,
              at: clock.now(),
              elapsed: clock.elapsed(),
              error,
            };
          }
        },
      );
    },
    /** A scheduled run: an Operation on one Target, listed like a command while it waits for and starts the run. */
    async runScheduledJob(request) {
      if (coordinator.draining()) return "passed";
      const recorded = (await deps.store.read()).targets.find(
        (target) => target.id === request.targetId,
      );
      if (!recorded) return "passed";
      const operationId = request.id;
      return await coordinator.onTarget<ScheduledRunResult>(
        recorded,
        { operationId, action: "job", phase: "starting" },
        "passed",
        async (entry) => {
          try {
            // Nothing starts until rigd has reconciled the Host session (the coordinator's gate).
            if (coordinator.gate.closed()) return "deferred";
            const state = await deps.store.read();
            const target = state.targets.find((t) => t.id === request.targetId);
            const job = target?.plan.jobs?.find((j) => j.name === request.job);
            const project = state.projects.find(
              (p) => p.id === target?.projectId,
            );
            if (!target || !job || job.scheduled === false || !project)
              return "passed";
            /** The time is passed over: recorded under this lease, so a later rigd never runs it. */
            const passOver = async (): Promise<ScheduledRunResult> => {
              await deps.store.update((state) =>
                recordScheduling(state, [
                  {
                    target: target.id,
                    job: job.name,
                    passedOver: new Date(request.scheduledFor).toISOString(),
                  },
                ]),
              );
              return "passed";
            };
            // The Target changed while this waited: it is no longer meant to run the job, or the time is too late to start.
            if (
              !schedulesJobs(target) ||
              Date.parse(deps.now()) - request.scheduledFor > JOB_LATE_LIMIT_MS
            )
              return await passOver();
            if (restartRecords.failedStartPending(target.id)) {
              await restartRecords.recordFailedStart(target);
              return "deferred";
            }
            if (!(await restartRecords.recordStop(target))) return "deferred";
            entry.view.project = project.name;
            // rig.yaml decides whether the role is on; a config that cannot be read leaves the Target to its record (ADR 0010).
            const configured = await checkoutConfig(undefined, project, deps);
            if (
              configured.document &&
              !targetOn(configured.document.config, target.kind)
            )
              return await passOver();
            try {
              await startJobRun(
                target,
                job,
                {
                  id: request.id,
                  trigger: "schedule",
                  scheduledFor: request.scheduledFor,
                },
                deps,
              );
              await releaseHeldCheckouts(target, deps);
              return "started";
            } catch (error) {
              if (!(error instanceof RigError) || error.code !== "JOB_RUNNING")
                throw error;
              await recordSkippedRun(
                target,
                job.name,
                request.scheduledFor,
                deps.id(),
                deps,
              );
              return "skipped";
            }
          } catch (error) {
            await deps
              .diagnostic({
                operationId,
                action: "job",
                outcome: "failed",
                target: recorded.name,
                errorCode: diagnosticErrorCode(error),
                ...diagnosticCauses(error),
              })
              .catch(() => {});
            // The run's own failure to start is the job's, which its record and Activity say; anything else is rigd's.
            const last = findJobRecord(
              await deps.store.read().catch(() => ({ jobs: [] })),
              request.targetId,
              request.job,
            )?.last;
            if (last?.id === request.id && last.outcome === "start-failed")
              return "failed";
            throw error;
          }
        },
      );
    },
    async releaseHeldCheckouts(targetId) {
      const state = await deps.store.read();
      const recorded = state.targets.find((target) => target.id === targetId);
      if (recorded) {
        // An Operation on the Target may be starting or stopping its Services: the next offer looks again.
        if (coordinator.targetBusy(recorded)) return "skipped";
        // Observed without the Target's lease, as the scheduler observes job runs: only a checkout nothing runs in any
        // more, or that is a plan's again, is worth taking the lease for, so a Service that keeps running in one costs
        // its Target nothing.
        // One whose standing cannot be read is tried under the lease too, where that failure is the offer's.
        let due = false;
        for (const held of state.heldCheckouts ?? [])
          if (
            held.target === targetId &&
            (await revisionStanding(held.workspace, state, deps).catch(
              () => "unknown" as const,
            )) !== "held"
          ) {
            due = true;
            break;
          }
        if (!due) return;
        return await onTarget(
          targetId,
          "held-checkout",
          async (target) => {
            const [failure] = await releaseHeldCheckouts(target, deps);
            if (failure) throw failure;
          },
          "supervising",
        );
      }
      // A Target removed meanwhile (a destroy) took its storage with it: only the mirror's registration is left to drop. Only
      // what was given back is forgotten; a failure stays for the scheduler's next offer.
      const [failure] = await forgetReleasedCheckouts(
        (state.heldCheckouts ?? []).filter((kept) => kept.target === targetId),
        deps,
      );
      if (failure) throw failure;
    },
    settleJob: (request) =>
      onTarget(request.targetId, "job", async (target, lifecycle) => {
        const run = (await deps.store.read()).jobs?.find(
          (record) =>
            record.target === request.targetId && record.job === request.job,
        )?.running;
        // Another run by now, started after the scheduler looked: what it judged is not about this one.
        if (run?.id !== request.runId) return;
        const held = { ...deps, lifecycle };
        if (request.timedOut)
          await stopJobRun(target, request.job, run, "timed-out", held);
        else await settleJobRun(target, request.job, run.id, held);
        await releaseHeldCheckouts(target, deps);
      }),
    // No lease: the Operation holding the Target may hold it for as long as a build takes, and the run's limit does not
    // wait for it. Only the run's own process is signalled, and its end is recorded by `settleJob` under the lease.
    async enforceJobDeadline(request) {
      if (coordinator.draining()) return;
      const target = (await deps.store.read()).targets.find(
        (t) => t.id === request.targetId,
      );
      if (!target) return;
      const enforcing = enforceJobDeadline(
        target,
        request.job,
        request.runId,
        deps,
        { detach: coordinator.detach },
      );
      coordinator.track(enforcing);
      try {
        await enforcing;
      } catch (error) {
        await deps
          .diagnostic({
            operationId: deps.id(),
            action: "job",
            outcome: "failed",
            target: target.name,
            errorCode: diagnosticErrorCode(error),
            ...diagnosticCauses(error),
          })
          .catch(() => {});
        throw error;
      }
    },
    async stopJobsIfOff(targetId) {
      const state = await deps.store.read();
      const target = state.targets.find((t) => t.id === targetId);
      const project = state.projects.find((p) => p.id === target?.projectId);
      if (!target || !project) return;
      const configured = await checkoutConfig(undefined, project, deps);
      // A config that cannot be read says nothing about the switch, and leaves the runs to their record (ADR 0010).
      if (
        !configured.document ||
        targetOn(configured.document.config, target.kind)
      )
        return;
      await onTarget(targetId, "job-off", async (held, lifecycle) => {
        const again = await checkoutConfig(undefined, project, deps);
        if (!again.document || targetOn(again.document.config, held.kind))
          return;
        await stopJobRuns(held, { ...deps, lifecycle });
        await releaseHeldCheckouts(held, deps);
      });
    },
  };
}
