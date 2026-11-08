import { z } from "zod";
/** The cached result of a Service's ongoing checks (its healthcheck), as rigd last saw it; status never runs one for it. */
export const serviceHealthSchema = z
  .object({
    status: z
      .enum(["starting", "healthy", "unhealthy"])
      .describe(
        "starting until a check of the running process answered; unhealthy once `retries` checks in a row failed, until one passes; healthy otherwise.",
      ),
    checkedAt: z
      .string()
      .optional()
      .describe("When the last check of this process answered (ISO 8601)."),
    failures: z.number().int().describe("Failed checks in a row."),
    retries: z
      .number()
      .int()
      .describe(
        "Failed checks in a row that make the Service unhealthy: its healthcheck's retries.",
      ),
    output: z
      .string()
      .optional()
      .describe(
        "The last failed check's output as one line of at most 200 characters; absent once a check passed.",
      ),
    restarts: z
      .number()
      .int()
      .describe(
        "Health restarts made since the Service became unhealthy this time (on_failure: restart).",
      ),
    restartFailed: z
      .literal(true)
      .optional()
      .describe(
        "The last health restart stopped the Service and its start failed the start check: it is stopped until the next health restart.",
      ),
    nextRestartAt: z
      .string()
      .optional()
      .describe(
        "When that next health restart is due (ISO 8601): 1 min, 5 min, 15 min and then every hour after the last.",
      ),
  })
  .passthrough();
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

const componentReportSchema = z
  .object({
    name: z.string().describe("Component identity within the Target."),
    kind: z
      .enum(["managed", "installed", "persistent"])
      .describe("Component capability kind."),
    state: z
      .enum([
        "configured",
        "unknown",
        "healthy",
        "unhealthy",
        "running",
        "starting",
        "stopping",
        "stopped",
        "failed",
        "installed",
        "missing",
        "ready",
      ])
      .describe(
        "Observed capability state; configured alone is not runtime evidence. `stopping` means an Operation is waiting for the Service to exit after its stop signal.",
      ),
    pid: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Observed process identifier, when available."),
    port: z
      .number()
      .int()
      .optional()
      .describe("Configured or recorded component port."),
    ports: z
      .record(z.string(), z.number().int())
      .optional()
      .describe(
        "Every declared port by name, as recorded in the plan; absent for a Service without ports or a plan recorded before named ports.",
      ),
    restarts: z
      .number()
      .int()
      .optional()
      .describe(
        "Recent automatic restart attempts after a crash or an unknown exit, those still inside the restart budget windows, including attempts the budget refused; older ones age out, so the count can fall. Absent when none.",
      ),
    route: z
      .string()
      .optional()
      .describe(
        "Configured or recorded route, even while stopped: the first of hostnames.",
      ),
    hostnames: z
      .array(z.string())
      .optional()
      .describe(
        "Every hostname whose '/' reaches this Service: the Target's domain when the Service serves its '/', then the Service's own domain. Absent when none does.",
      ),
    commit: z
      .string()
      .optional()
      .describe(
        "For a running Service of a deployed Target: the Commit its process was started from. One that differs from the Target's Commit was kept running by a deploy that changed nothing it uses (kept from that Commit); absent when the process predates this record.",
      ),
    exitCode: z
      .number()
      .int()
      .optional()
      .describe("Observed process exit evidence."),
    signal: z
      .string()
      .optional()
      .describe("Signal that ended the process, when recorded."),
    exit: z
      .enum(["clean", "failed", "requested", "unknown"])
      .optional()
      .describe(
        "How a stopped Service ended: a clean exit, a failure, a stop an operator requested, or unknown when nothing recorded it. An unknown exit is started again automatically only under restart: always, on a slower budget; one caused by a Host restart (the reason says so) is not, for the working Target and Previews, until rig up.",
      ),
    killAt: z
      .string()
      .optional()
      .describe(
        "For a stopping Service: when SIGKILL is due (ISO 8601), once its stop_timeout has passed.",
      ),
    reason: z.string().optional().describe("Explanation of the observation."),
    health: serviceHealthSchema
      .optional()
      .describe(
        "For a running Service with a healthcheck: the cached result of its ongoing checks, which decides healthy or unhealthy.",
      ),
  })
  .passthrough();
const jobRunReportSchema = z
  .object({
    trigger: z
      .enum(["schedule", "manual", "restore"])
      .describe(
        "What started it: the schedule, rig run, or rig backup restore (a run of the job's restore command).",
      ),
    backup: z
      .string()
      .optional()
      .describe(
        "A backup job's run: the id of the backup it writes, kept if it succeeds.",
      ),
    restore: z
      .string()
      .optional()
      .describe("A restore: the id of the backup it reads."),
    scheduledFor: z
      .string()
      .optional()
      .describe("The scheduled time a scheduled run was for (ISO 8601)."),
    startedAt: z.string().describe("When the run started (ISO 8601)."),
    finishedAt: z
      .string()
      .optional()
      .describe("When it ended (ISO 8601); absent while it runs."),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("How long it ran, in milliseconds; absent while it runs."),
    outcome: z
      .enum([
        "succeeded",
        "failed",
        "timed-out",
        "stopped",
        "unknown",
        "start-failed",
      ])
      .optional()
      .describe(
        "How it ended: exit 0; another exit or a signal; stopped at its timeout; stopped by Rig (rig down, a Preview destroy or its Target turned off; a deploy or restart never stops a run); gone with nothing recording how (the Mac restarted); or never started. Absent while it runs.",
      ),
    exitCode: z
      .number()
      .int()
      .optional()
      .describe("Its exit code, when one was recorded."),
    signal: z
      .string()
      .optional()
      .describe("The signal that ended it, when recorded."),
    errorCode: z.string().optional().describe("Why a start failed."),
    skipped: z
      .number()
      .int()
      .optional()
      .describe("Scheduled times skipped because this run was still going."),
    summary: z
      .string()
      .describe(
        "One line about the run, as rig status and rig activity show it.",
      ),
  })
  .passthrough();
const backupSummarySchema = z
  .object({
    keep: z
      .number()
      .int()
      .describe("How many successful backups the job keeps."),
    restore: z
      .boolean()
      .describe(
        "Whether the job has a restore command, so rig backup restore can put a backup back.",
      ),
    count: z.number().int().describe("How many backups are kept now."),
    bytes: z
      .number()
      .int()
      .describe("Their total size in bytes, of those whose size is recorded."),
    latest: z
      .object({
        id: z.string().describe("Its id, its run's start in UTC."),
        finishedAt: z.string().describe("When its run ended (ISO 8601)."),
        bytes: z.number().int().optional().describe("Its size in bytes."),
      })
      .passthrough()
      .optional()
      .describe("The newest backup; absent when there is none yet."),
  })
  .passthrough();
const jobReportSchema = z
  .object({
    name: z.string().describe("The job's name under jobs in rig.yaml."),
    schedule: z
      .string()
      .optional()
      .describe("Its five-field cron expression; absent for a removed job."),
    timeZone: z
      .string()
      .optional()
      .describe(
        "The IANA time zone the schedule is read in: the job's timezone, else the Host's.",
      ),
    state: z
      .enum(["running", "idle"])
      .describe("running while a run is in progress, otherwise idle."),
    removed: z
      .literal(true)
      .optional()
      .describe(
        "The job is gone from the Target's plan (a deploy dropped it), and this run of it still goes on its earlier checkout.",
      ),
    scheduled: z
      .boolean()
      .describe(
        "Whether its schedule runs it now: its targets name this Target's role, and the Target is deployed, meant to run and on in rig.yaml. A Target stopped with rig down, or turned off, runs none of its jobs; rig run runs a job its targets do not name.",
      ),
    nextRunAt: z
      .string()
      .optional()
      .describe(
        "When the schedule runs it next (ISO 8601); absent when it is not scheduled.",
      ),
    timeout: z
      .number()
      .int()
      .optional()
      .describe(
        "Seconds one run may take before it is stopped; absent when unlimited.",
      ),
    running: jobRunReportSchema.optional().describe("The run in progress."),
    last: jobRunReportSchema.optional().describe("The latest run that ended."),
    reason: z.string().optional().describe("Why it is not scheduled."),
    backup: backupSummarySchema
      .optional()
      .describe(
        "For a backup job (backup: in rig.yaml): its kept backups in this Target. Absent for any other job.",
      ),
  })
  .passthrough();
const refusalSchema = z
  .object({
    code: z.string().describe("The error code the command fails with."),
    message: z.string().describe("Why it is refused, as the command says it."),
    hint: z.string().describe("What to do about it, as the command says it."),
  })
  .passthrough();
const targetRefusalsSchema = z
  .object({
    up: refusalSchema.optional().describe("Why rig up is refused."),
    restart: refusalSchema.optional().describe("Why rig restart is refused."),
    deploy: refusalSchema.optional().describe("Why rig deploy is refused."),
    run: refusalSchema.optional().describe("Why rig run is refused."),
    restore: refusalSchema
      .optional()
      .describe("Why rig backup restore is refused."),
  })
  .passthrough();
const projectRefusalsSchema = z
  .object({
    rename: refusalSchema.optional().describe("Why rig rename is refused."),
    repoint: refusalSchema.optional().describe("Why rig repoint is refused."),
    forget: refusalSchema.optional().describe("Why rig forget is refused."),
  })
  .passthrough();
const targetReportSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "The Target's stable id, the targetId of its monitor series. A Preview destroyed and created again under the same name has a new one. Absent for a Target rig.yaml names and nothing has recorded yet.",
      ),
    name: z.string().describe("Target identity used for selection."),
    kind: z
      .enum(["working", "stable", "preview"])
      .describe("The Target role: working, stable or preview."),
    state: z
      .enum([
        "configured",
        "unknown",
        "healthy",
        "unhealthy",
        "running",
        "starting",
        "stopping",
        "stopped",
        "failed",
        "ready",
        "degraded",
      ])
      .describe(
        "Aggregate Target state without replacing individual observations. `stopping` means an Operation is waiting for the Target's Services to exit right now.",
      ),
    branch: z.string().optional().describe("Recorded source Branch."),
    commit: z.string().optional().describe("Recorded source Commit."),
    deploymentIncomplete: z
      .boolean()
      .optional()
      .describe(
        "True when the recorded Commit's deploy failed or was interrupted before completing; absent when complete.",
      ),
    transitionPending: z
      .boolean()
      .optional()
      .describe(
        "True while a deployment transition is unresolved (in progress or awaiting down); absent otherwise.",
      ),
    destructionPending: z
      .boolean()
      .optional()
      .describe(
        "True when a Preview's destroy did not finish and its stopped inventory is retained until down --destroy is retried; absent otherwise.",
      ),
    leftoverBuild: z
      .boolean()
      .optional()
      .describe(
        "True while a build an earlier rigd started, and left when it crashed, still runs: rigd stops it as it starts and before the next build, and rig down stops it; absent otherwise.",
      ),
    route: z
      .string()
      .optional()
      .describe("Recorded Target route: the hostname domain gives it."),
    hostnames: z
      .array(z.string())
      .optional()
      .describe(
        "Every hostname the Target serves, published and withdrawn together: its domain first, then each Service domain. Absent when it serves none.",
      ),
    routes: z
      .array(
        z
          .object({
            prefix: z.string().describe("Path prefix such as / or /api."),
            service: z.string().describe("The Service that serves it."),
            port: z.number().int().describe("The Service port it reaches."),
          })
          .passthrough(),
      )
      .optional()
      .describe(
        "The recorded path routes under the Target's hostname, longest prefix first; absent without a hostname or for a plan recorded before route maps.",
      ),
    serviceDomains: z
      .array(
        z
          .object({
            hostname: z.string().describe("The Service domain's hostname."),
            service: z.string().describe("The Service every path reaches."),
            port: z.number().int().describe("The Service port it reaches."),
          })
          .passthrough(),
      )
      .optional()
      .describe(
        "The recorded hostnames of the Target's Service domains, each routing every path to one Service port; absent when it has none.",
      ),
    routePublished: z
      .boolean()
      .optional()
      .describe(
        "False when the host Caddy does not load Rig's route file, so the route is inert; absent when published or unknown.",
      ),
    refusals: targetRefusalsSchema
      .optional()
      .describe(
        "The commands rigd refuses on this Target as it stands now, each with the code, message and hint the command fails with: the Target is off in rig.yaml, not recorded yet, mid-destruction or in an unresolved transition, or for run and restore, stopped or incompletely deployed. Absent when none is. A command not listed can still fail for what only running it finds out, such as a job already running.",
      ),
    components: z
      .array(componentReportSchema)
      .describe("Configured and observed component capabilities."),
    jobs: z
      .array(jobReportSchema)
      .optional()
      .describe(
        "The scheduled jobs the Target's plan runs, with their last and next run; absent when it runs none.",
      ),
  })
  .passthrough();
export const projectStatusSchema = z
  .object({
    project: z.string().describe("Registered Project identity."),
    projectId: z
      .string()
      .optional()
      .describe(
        "The Project's stable id, the projectId of its monitor series; a Project forgotten and registered again has a new one.",
      ),
    targets: z
      .array(targetReportSchema)
      .describe("Available Targets; an empty array is valid."),
    refusals: projectRefusalsSchema
      .optional()
      .describe(
        "The registration changes rigd refuses as the Project stands now, each with the code, message and hint the command fails with: a Target runs, is meant to run, is mid-transition or runs a job, or for forget, a Preview remains. Absent when none is, and from a status narrowed to one Target, which does not observe the others.",
      ),
    warnings: z
      .array(z.string())
      .optional()
      .describe(
        "Project configuration or recovery warnings; older replies may omit them.",
      ),
  })
  .passthrough();
export type ComponentReport = z.infer<typeof componentReportSchema>;
export type JobReport = z.infer<typeof jobReportSchema>;
export type JobRunReport = z.infer<typeof jobRunReportSchema>;
export type BackupSummaryReport = z.infer<typeof backupSummarySchema>;
export type TargetReport = z.infer<typeof targetReportSchema>;
export type ProjectStatusReport = z.infer<typeof projectStatusSchema>;
export interface StatusSelection {
  project?: string;
  repoPath?: string;
  /** `working`, `stable` or `preview`; none selects every Target. */
  target?: string;
  deployment?: string;
  branch?: string;
  operationId?: string;
}
export interface ProjectStatusReader {
  /** The signal, when given, abandons the read as CANCELLED. */
  status(
    selection: StatusSelection,
    signal?: AbortSignal,
  ): Promise<ProjectStatusReport>;
}
