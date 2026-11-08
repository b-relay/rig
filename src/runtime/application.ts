import type { ProjectStatusReader } from "../domain/project-status";
import type { RuntimeCommand } from "../daemon/protocol";
import type { TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { reportingTransitions } from "./health-transitions";
import type {
  HealthRestartRequest,
  HealthRestartResult,
} from "./health-monitor";
import type {
  JobSettleRequest,
  ScheduledRunRequest,
  ScheduledRunResult,
} from "./job-scheduler";
import { tidyBackups } from "./backups";
import { createOperationCoordinator } from "./operation-coordinator";
import {
  createSupervisionPasses,
  type SupervisionPass,
} from "./supervision-passes";
import { createOrphanSweep } from "./orphan-routes";
import { createCommandRunner } from "./command-execution";
import { createBackgroundOperations } from "./background-operations";
import { statusReader } from "./project-reads";

export type { SupervisionPass } from "./supervision-passes";
export type { RetiredPreview } from "./previews";
export { hostnameRelease } from "./orphan-routes";

export interface RigRuntime extends ProjectStatusReader {
  /** Whether an Operation holds or waits for `target`, so one of its Services may be starting or stopping. A supervision
   * pass that only observes the Target does not count; one that is starting a Service again does. */
  targetBusy(
    target: Pick<TargetRecord, "projectId" | "kind" | "name">,
  ): boolean;
  /** Restarts one Service the health monitor found unhealthy, as an Operation on its Target: it waits for the Target like
   * any command, stops the Service within its stop_timeout and starts it again. Never rejects; failures are recorded. */
  restartUnhealthy(request: HealthRestartRequest): Promise<HealthRestartResult>;
  /** Gives back the checkouts of the Target `targetId` that job runs or kept Services held after a deploy, once nothing
   * runs in them, under the Target's lease; drops those of a Target that is gone. A failure is recorded, and rejects;
   * `skipped` when an Operation held the Target, so nothing was tried. */
  releaseHeldCheckouts(targetId: string): Promise<void | "skipped">;
  /** Withdraws every route block whose Target no state record names, so a hostname a forgotten or lost Target held can be
   * published again; rigd runs it once it has started, and a deploy, up or restart of a Target with a route runs it first
   * (`rig proxy reload` runs its own, failing when it fails). Withdraws nothing while the route file lies outside the Rig
   * root (`routeFileInRoot`), where another root may own its blocks. Resolves with the hostnames withdrawn. Never
   * rejects: a failure is recorded, and doctor's route-owners check keeps naming the blocks. */
  withdrawOrphanedRoutes(): Promise<string[]>;
  /** Measures any backup a rigd that stopped right after its run left without a size, then deletes the backup
   * directories queued for deletion (failed runs', and backups past keep or of a destroyed Preview), forgetting each one
   * deleted. Rejects only when the state cannot be read; each backup's own failure is a diagnostic, tried again later. */
  tidyBackups(): Promise<void>;
  /** Settles a run the scheduler judged ended or past its timeout, under its Target's lease: reads the run again and acts
   * only when the record still names it, stopping it (timed out) only while its own process runs. A failure is recorded,
   * and rejects. */
  settleJob(request: JobSettleRequest): Promise<void>;
  /** Stops a run past its timeout while an Operation holds its Target, without waiting for its lease: only the process
   * carrying the run's incarnation is signalled, and the run's end is left to `settleJob`. A failure is recorded, and
   * rejects. */
  enforceJobDeadline(request: JobSettleRequest): Promise<void>;
  /** Stops the job runs in progress of the Target `targetId` when rig.yaml turns its role off, under its lease, as rig down
   * would. A failure is recorded, and rejects. */
  stopJobsIfOff(targetId: string): Promise<void>;
  /** Runs one scheduled time of a job as an Operation on its Target: it waits for the Target like any command, then starts
   * a run when the Target is still deployed, meant to run and on in rig.yaml, the job is still in its plan and the time is
   * not past the late limit; a run still going makes it record the time skipped. A run whose start failed is `failed`, as
   * its record says; a failure to do or record any of this is recorded, and rejects. */
  runScheduledJob(request: ScheduledRunRequest): Promise<ScheduledRunResult>;
  command(command: RuntimeCommand): Promise<unknown>;
  /** The daemon's first pass: adopts what survived, re-stops what was meant to stop, and applies restart policy. */
  reconcile(): Promise<SupervisionPass>;
  /** A later pass: applies restart policy to the Targets meant to run. Never raises; failures go to the diagnostic log and
   * are reported to `supervision`, each Target's until supervising it succeeds again (or it is no longer supervised). */
  supervise(): Promise<SupervisionPass>;
  /** Runs `operation`, a config edit, while no other config edit, `init`, `rename`, `repoint` or `forget` of the named
   * Project runs. It does not wait for the Project's Target operations, which run beside it and plan from rig.yaml as it
   * is once they are admitted. A name no Project is registered under is serialized with that name's registration instead. */
  exclusive<T>(project: string, operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}
/** rigd is the one authority over lifecycle state. Mutations of one Target run one at a time; other
 * Targets and Projects run side by side and share Host resources through short critical sections.
 * Read-only requests never wait. See docs/adr/0007-per-target-operation-queue.md, and
 * docs/reviews/2026-11-08-runtime-application-split.md for which module owns what. */
export function createRuntime(input: RuntimeDependencies): RigRuntime {
  // Every write the runtime makes reports its lifecycle transitions to the health monitor as it is applied, while the
  // Operation making it still holds its Target (the epochs of health-cache.ts).
  const deps: RuntimeDependencies = input.healthTransitions
    ? {
        ...input,
        store: reportingTransitions(input.store, input.healthTransitions),
      }
    : input;
  const coordinator = createOperationCoordinator(deps);
  const passes = createSupervisionPasses(deps, coordinator);
  const sweep = createOrphanSweep(deps);
  const status = statusReader(deps, coordinator);
  const run = createCommandRunner({
    coordinator,
    restartRecords: passes.restartRecords,
    sweep,
    status,
  });
  const background = createBackgroundOperations(
    deps,
    coordinator,
    passes.restartRecords,
  );
  return {
    status,
    restartUnhealthy: background.restartUnhealthy,
    runScheduledJob: background.runScheduledJob,
    // No Target is held: nothing reads a queued directory once it left the inventory, and measuring a kept one only reads it.
    tidyBackups: () => tidyBackups(deps),
    withdrawOrphanedRoutes: async () => (await sweep.sweep()).withdrawn,
    releaseHeldCheckouts: background.releaseHeldCheckouts,
    settleJob: background.settleJob,
    enforceJobDeadline: background.enforceJobDeadline,
    stopJobsIfOff: background.stopJobsIfOff,
    targetBusy: coordinator.targetBusy,
    drain: coordinator.drain,
    exclusive: coordinator.exclusive,
    command: (command) => coordinator.command(command, run),
    reconcile: () => passes.pass("reconcile"),
    supervise: () => passes.pass("supervise"),
  };
}
