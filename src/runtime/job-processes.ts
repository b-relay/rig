import type { TargetRecord } from "../domain/runtime";
import { rigCommand } from "../domain/rig-command";
import { serviceGraceMs } from "../domain/stop-budget";
import { RigError } from "../domain/errors";
import type { StopResult } from "../providers/contracts";
import { jobDirectory } from "../config/working-dir";
import type {
  JobStop,
  StopControl,
  TargetEffects,
  TargetLifecycle,
} from "./lifecycle";

/** A Target's job runs under its supervisor, one process per job: started with a freshly composed environment, observed,
 * and stopped within the stop_timeout the run started with. */
export type JobProcesses = Pick<
  TargetLifecycle,
  "startJob" | "observeJob" | "stopJob"
>;
/** The supervisor key of a Target's job runs. A Service name never holds ':', so it never collides with a Service's. */
export function jobProcessKey(
  target: Pick<TargetRecord, "id">,
  job: string,
): string {
  return `${target.id}:job:${job}`;
}
export function createJobProcesses(effects: TargetEffects): JobProcesses {
  /** Stops `job`'s run in progress within its stop_timeout under `stops`, telling the observers as the stop begins and ends;
   * a job with nothing running is left alone, unannounced. */
  async function stopJob(
    target: TargetRecord,
    job: JobStop,
    stops: StopControl = {},
  ): Promise<StopResult> {
    const supervisor = effects.supervisor(target),
      key = jobProcessKey(target, job.name);
    if ((await supervisor.observe(key)).state === "stopped")
      return { outcome: "unchanged" };
    const graceMs = serviceGraceMs(job.stopTimeout);
    const kill = stops.kill?.(target);
    stops.observer?.stopping(target, job.name, graceMs);
    try {
      const result = await supervisor.stop(key, {
        graceMs,
        ...(job.incarnation !== undefined
          ? { incarnation: job.incarnation }
          : {}),
        ...(kill ? { kill } : {}),
        ...(stops.detach ? { detach: stops.detach } : {}),
      });
      stops.observer?.stopped(target, job.name, result);
      return result;
    } catch (error) {
      stops.observer?.stopped(target, job.name, { outcome: "failed" });
      throw error;
    }
  }
  return {
    async startJob(target, job, incarnation, rigEnv) {
      // Read before anything is spawned, so an unreadable env file leaves nothing running.
      const env = { ...(await effects.environment(target, job)), ...rigEnv };
      const result = await effects.supervisor(target).ensureRunning({
        key: jobProcessKey(target, job.name),
        componentName: job.name,
        command: ["/bin/sh", "-c", job.command],
        cwd: jobDirectory(target.plan, job),
        ...(job.workingDir !== undefined
          ? { cwdWithin: target.plan.workspacePath }
          : {}),
        env,
        logRoot: target.logRoot,
        incarnation,
        stopGraceMs: serviceGraceMs(job.stopTimeout),
      });
      // A process already running under the job's key is another run's, which this run must never be recorded as.
      if (result.outcome !== "started")
        throw new RigError(
          "JOB_RUNNING",
          `A process of ${job.name} is already running on ${target.name}, so no new run was started.`,
          `Wait for it to end, or stop it with ${rigCommand("down", { target })}.`,
          { job: job.name },
        );
    },
    observeJob: (target, job, signal) =>
      effects.supervisor(target).observe(jobProcessKey(target, job), signal),
    stopJob,
  };
}
