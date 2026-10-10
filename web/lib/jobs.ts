import { z } from "zod";
import type { RuntimeCommand, TargetReport } from "./types";

/* Scheduled jobs (`jobs:` in rig.yaml, `rig run <job>`) are being built on branch feat/scheduled-jobs and
 * are not in rigd yet. The dashboard reads them through this one module, in the shape that branch adds to
 * each Target of the status reply (`targets[].jobs`). Until it lands, status carries no `jobs` and every page
 * says so; once it lands, the pages show them with no other change.
 * TODO(feat/scheduled-jobs): replace these schemas with the types from src/domain/project-status, and enable
 * `runJobCommand` once the protocol accepts `action: "run"` with `job`. */

const jobRunSchema = z
  .object({
    trigger: z.enum(["schedule", "manual"]),
    scheduledFor: z.string().optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    durationMs: z.number().optional(),
    outcome: z
      .enum([
        "succeeded",
        "failed",
        "timed-out",
        "stopped",
        "unknown",
        "start-failed",
      ])
      .optional(),
    exitCode: z.number().optional(),
    signal: z.string().optional(),
    errorCode: z.string().optional(),
    skipped: z.number().optional(),
    summary: z.string(),
  })
  .passthrough();
const jobSchema = z
  .object({
    name: z.string(),
    schedule: z.string(),
    timeZone: z.string(),
    state: z.enum(["running", "idle"]),
    scheduled: z.boolean(),
    nextRunAt: z.string().optional(),
    timeout: z.number().optional(),
    running: jobRunSchema.optional(),
    last: jobRunSchema.optional(),
    reason: z.string().optional(),
  })
  .passthrough();
/** One scheduled job of a Target as the dashboard shows it. */
export type JobView = z.infer<typeof jobSchema>;
export type JobRunView = z.infer<typeof jobRunSchema>;
/** What a Target's status says about its jobs: `unsupported` while this rigd reports none at all. */
export type TargetJobs =
  { supported: false } | { supported: true; jobs: JobView[] };

/** Pure: a Target's jobs from its status report. A report without `jobs` comes from a rigd that has no
 * scheduled jobs yet (or a Target whose plan runs none, which the jobs branch reports the same way);
 * a malformed list is treated as absent rather than shown wrong. */
export function targetJobs(target: TargetReport): TargetJobs {
  const raw = (target as { jobs?: unknown }).jobs;
  if (raw === undefined) return { supported: false };
  const parsed = z.array(jobSchema).safeParse(raw);
  return parsed.success
    ? { supported: true, jobs: parsed.data }
    : { supported: false };
}
/** Whether rigd accepts a command that starts a job now. False until feat/scheduled-jobs lands. */
export const RUN_JOB_SUPPORTED = false;
/** Pure: the command that runs one job of a Target now, as `rig run <job>` will send it; undefined while
 * rigd has no such command. */
export function runJobCommand(
  _project: string,
  _target: Pick<TargetReport, "kind" | "name">,
  _job: string,
): RuntimeCommand | undefined {
  // TODO(feat/scheduled-jobs): return { action: "run", project, ...targetSelector(target), job }.
  return undefined;
}
