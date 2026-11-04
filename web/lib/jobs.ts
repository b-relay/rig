import { refusalText } from "./present";
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
/** Pure: why "Run now" cannot start `job`, or undefined when it can: whatever rigd refuses of the Target now, a job the
 * Target's plan no longer has, and a run of it still going (runs never overlap). The schedule's own `scheduled` does not
 * matter otherwise: rig run runs a job its targets do not name. */
export function runBlocked(
  job: JobView,
  target: Pick<TargetReport, "refusals">,
): string | undefined {
  if (target.refusals?.run) return refusalText(target.refusals.run);
  if (job.removed)
    return "This job is no longer in rig.yaml; its last run finishes on its own.";
  if (job.state === "running")
    return `${job.name} is running; runs never overlap.`;
  return undefined;
}
/** Pure: the command that runs one job of a Target now, as `rig run <job> <target>` sends it. */
export function runJobCommand(
  project: string,
  target: Pick<TargetReport, "kind" | "name">,
  job: string,
): RuntimeCommand {
  return { action: "run", project, ...targetSelector(target), job };
}
