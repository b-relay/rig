import { targetSelector } from "./target";
import type {
  JobReport,
  JobRunReport,
  RuntimeCommand,
  TargetReport,
} from "./types";

/* Scheduled jobs (`jobs:` in rig.yaml, `rig run <job>`, ADR 0013) as each Target of the status reply reports
 * them (`targets[].jobs`). The page is bundled into the rigd that answers it, so these are the domain's own types. */

/** One job of a Target as the dashboard shows it. */
export type JobView = JobReport;
export type JobRunView = JobRunReport;

/** Pure: a Target's jobs from its status report, in plan order, then any run still going of a job a deploy removed. A
 * Target whose plan has no jobs reports none. */
export function targetJobs(target: TargetReport): JobView[] {
  return target.jobs ?? [];
}
/** Pure: whether "Run now" can start `job`: not while a run of it goes (runs never overlap), and not for a job the
 * Target's plan no longer has. The schedule's own `scheduled` does not matter: rig run runs a job in any Target. */
export function canRunNow(job: JobView): boolean {
  return job.state !== "running" && !job.removed;
}
/** Pure: the command that runs one job of a Target now, as `rig run <job> <target>` sends it. */
export function runJobCommand(
  project: string,
  target: Pick<TargetReport, "kind" | "name">,
  job: string,
): RuntimeCommand {
  return { action: "run", project, ...targetSelector(target), job };
}
