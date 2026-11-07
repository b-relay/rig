import { isAbsolute } from "node:path";
import { z } from "zod";
import { OPERATION_OUTCOMES } from "../domain/activity";
import { CONTENT_MAX } from "../domain/dns-records";
import { MAX_NAME_LENGTH, NAME_PATTERN } from "../domain/names";

/** Only domain commands cross the local control plane, never arbitrary scripts. */
/** The names rig checks before sending, so a bad flag is named instead of read as version skew. */
export const projectName = z.string().min(1).max(MAX_NAME_LENGTH);
export const previewName = z.string().regex(NAME_PATTERN);
/** A component name `rig logs --service` or `rig run` may send: the shape every Service, Tool and job name has. Like config, it sets no
 * length limit of its own; the control plane's request size bounds it. */
export const logComponentName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
/** A backup id, its run's start in UTC and its number in the job's backup sequence (`20261011T030000Z-17`), or `latest`. */
export const backupSelector = z
  .string()
  .regex(/^(?:latest|\d{8}T\d{6}Z-[1-9]\d{0,15})$/);
/** rig resolves paths against the caller's directory before sending; rigd never resolves against its own. */
export const absolutePath = z.string().min(1).refine(isAbsolute, {
  message: "must be an absolute path",
});
/** The `dns` field of a DNS command as the control plane carries it. Record content rules are checked by `prepare`, so a
 * mistyped address is a DNS_RECORD refusal naming the field rather than an invalid request. */
export const dnsRequestSchema = z.strictObject({
  zone: z
    .string()
    .max(253)
    .optional()
    .describe(
      "The zone, such as example.com. A read with one reads that zone and any zone its hostnames' CNAMEs lead to, and fails if that zone cannot be read. A read without one reads every zone Rig manages and reports those it could not read beside the rest.",
    ),
  id: z
    .string()
    .regex(/^[A-Za-z0-9]{1,64}$/)
    .optional()
    .describe("The record an update or delete acts on, as the read listed it."),
  modifiedOn: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "When the record was last changed, as the read listed it; the write is refused once it differs.",
    ),
  record: z
    .strictObject({
      name: z
        .string()
        .max(253)
        .describe(
          "Fully qualified record name in the zone, such as app.example.com or *.example.com.",
        ),
      type: z.string().max(16).describe("A, AAAA, CNAME, TXT, MX or CAA."),
      content: z
        .string()
        .max(CONTENT_MAX)
        .describe(
          "An address, a hostname, TXT text or CAA data, by type; rigd checks it against the type's rules.",
        ),
      ttl: z
        .number()
        .int()
        .describe("Seconds: 1 for automatic, or 30 to 86400."),
      proxied: z
        .boolean()
        .optional()
        .describe(
          "A, AAAA and CNAME only: answer through the provider's proxy.",
        ),
      priority: z
        .number()
        .int()
        .optional()
        .describe("MX only, and required there."),
      comment: z
        .string()
        .max(1000)
        .optional()
        .describe(
          "A note kept with the record; absent on an update keeps the stored one.",
        ),
    })
    .optional()
    .describe("The record a create or update writes."),
  absent: z
    .boolean()
    .optional()
    .describe(
      "A create that expects the name to have no record of its type (nor a CNAME) yet, as the read showed.",
    ),
  confirm: z
    .string()
    .max(254)
    .optional()
    .describe(
      "dns-delete only, and required there: the record's full name as the person typed it to confirm. rigd compares it with the record it reads just before deleting.",
    ),
});
export const commandSchema = z
  .object({
    action: z
      .enum([
        "initialization-info",
        "deployment-context",
        "list",
        "status",
        "doctor",
        "config",
        "init",
        "up",
        "down",
        "restart",
        "deploy",
        "logs",
        "activity",
        "rename",
        "repoint",
        "forget",
        "destroy",
        "prepare-uninstall",
        "cancel-uninstall",
        "prepare-stop",
        "queue",
        "deployments",
        "run",
        "proxy",
        "proxy-apply",
        "backups",
        "restore",
        "dns",
        "dns-create",
        "dns-update",
        "dns-delete",
        "monitor",
      ])
      .describe(
        "What rigd is asked to do. Reads (initialization-info, deployment-context, list, status, doctor, config, logs, activity, queue, deployments, proxy, backups, dns, monitor) never wait behind a running Operation. Every other action runs as an Operation, except prepare-stop, which rigd's host answers itself.",
      ),
    operationId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "The id the caller chose for this Operation, so its Diagnostic log and Activity entries can be traced across rig and rigd; rigd makes one when absent.",
      ),
    project: projectName
      .optional()
      .describe(
        "A registered Project's name (--project), which selects it ahead of repoPath. For init, the name to register; it must match the name an existing rig.yaml declares.",
      ),
    repoPath: absolutePath
      .optional()
      .describe(
        "The directory the command was run in. Without project, rigd selects the Project of the nearest rig.yaml at or above it.",
      ),
    target: z
      .string()
      .min(1)
      .max(63)
      .optional()
      .describe(
        "The Target selector: working, stable or preview, and a Preview then needs branch or deployment. Absent means the working Target, except for run and restore, which then use the stable Target; rig sends stable for a deploy that names none.",
      ),
    branch: z
      .string()
      .optional()
      .describe(
        "A local Branch: the one a Preview is selected or deployed by, or the one a stable deploy names. A preview deploy without one uses the repository's current Branch, a stable deploy the Production branch.",
      ),
    commit: z
      .string()
      .optional()
      .describe(
        "deploy only: the Commit to deploy instead of the Branch's tip; the dashboard names one of the Branch's, as its rollback does. rig never sends one.",
      ),
    deployment: previewName
      .optional()
      .describe(
        "A Preview's own name (--deployment), in place of the name Rig makes from its Branch: on deploy the name to give it, elsewhere the Preview to select.",
      ),
    targetId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "deploy only: the Target the request was made for, by its id in status. A Target since destroyed and made again under the same name is refused as TARGET_REPLACED, so a rollback never lands on the replacement.",
      ),
    domain: z
      .string()
      .optional()
      .describe(
        "init only: the domain a new rig.yaml gives the Project (--domain); it needs a Service to serve it.",
      ),
    service: z
      .object({
        name: z.string().describe("The Service's name in the new rig.yaml."),
        command: z.string().describe("The command that runs it."),
        port: z
          .number()
          .int()
          .optional()
          .describe(
            "The port its one port, http, is fixed to; absent lets Rig choose one.",
          ),
        healthcheck: z
          .string()
          .optional()
          .describe(
            "Its healthcheck test: a shell command or a local http(s) URL.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "init only: the Service a new rig.yaml declares (--service with --command). A new Project needs this or tool.",
      ),
    tool: z
      .object({
        name: z.string().describe("The Tool's name in the new rig.yaml."),
        bin: z
          .string()
          .describe(
            "The executable it publishes, as a path relative to the workspace.",
          ),
        build: z
          .string()
          .optional()
          .describe("The command that builds it; absent for none."),
      })
      .strict()
      .optional()
      .describe(
        "init only: the Tool a new rig.yaml declares (--tool with --bin). A new Project needs this or service.",
      ),
    createGit: z
      .boolean()
      .optional()
      .describe(
        "init only: make the directory a Git repository when it is not in one (--create-git). Without it, such an init fails as GIT_REQUIRED.",
      ),
    productionBranch: z
      .string()
      .optional()
      .describe(
        "init only: the Production branch a new rig.yaml records. Absent uses the remote's default Branch, or else the Host config default; an existing rig.yaml keeps its own.",
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "deploy only: deploy even when the selected Commit is the one already deployed (--force). Such a deploy keeps no Service running.",
      ),
    noUp: z
      .boolean()
      .optional()
      .describe(
        "deploy only: materialize and prepare the Deployment without starting it (--no-up); a running Target it replaces is stopped.",
      ),
    kill: z
      .boolean()
      .optional()
      .describe(
        "down, restart and destroy only: skip each Service's stop_timeout, SIGTERM then SIGKILL after the kill wait. A stop already running on the Target is cut short too.",
      ),
    lines: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe(
        "logs, activity and deployments: how many entries or records to return, the newest ones (or, with after, the next ones). Absent is 100.",
      ),
    logFilter: z
      .strictObject({
        services: z
          .array(logComponentName)
          .min(1)
          .max(64)
          .optional()
          .describe(
            "Component names (Services, Tools or jobs) to keep; on a first page, rigd refuses a name the Target does not have.",
          ),
        stream: z
          .enum(["stdout", "stderr"])
          .optional()
          .describe("Keep only this output stream."),
        since: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            "Keep entries at or after this ISO instant; rig resolves durations such as 1h against its own clock before sending.",
          ),
        until: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("Keep entries at or before this ISO instant."),
      })
      .optional()
      .describe(
        "Narrows a logs read; absent reads every entry. lines counts the entries it keeps.",
      ),
    job: logComponentName
      .optional()
      .describe(
        "The job run or restore acts on: a name under jobs in rig.yaml that the selected Target's plan runs.",
      ),
    backup: backupSelector
      .optional()
      .describe(
        "The backup restore puts back: its id, or latest; rig resolves latest before it asks for confirmation.",
      ),
    operation: z
      .string()
      .min(1)
      .optional()
      .describe(
        "An Operation id, the one a failed command prints: an activity read narrows to the records whose id starts with it, and a queue read reports where that Operation stands.",
      ),
    activityFilter: z
      .strictObject({
        target: z
          .string()
          .min(1)
          .max(63)
          .optional()
          .describe("A Target's name: working, stable or a Preview's name."),
        action: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("What the record is about, such as deploy, crash or job."),
        outcome: z
          .enum(OPERATION_OUTCOMES)
          .optional()
          .describe("Keep only records with this final outcome."),
        since: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            "Keep records at or after this ISO instant; rig resolves durations such as 1h against its own clock before sending.",
          ),
        until: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("Keep records at or before this ISO instant."),
      })
      .optional()
      .describe(
        "Narrows an activity read; absent keeps every record. lines counts the records it keeps.",
      ),
    after: z
      .string()
      .optional()
      .describe(
        "logs only: the cursor a previous page returned, sent back unchanged to read the entries written after it. Absent reads the newest page.",
      ),
    newName: z
      .string()
      .optional()
      .describe("rename only: the Project's new name."),
    newPath: absolutePath
      .optional()
      .describe(
        "repoint only: the directory the Project's repository is in now.",
      ),
    dns: dnsRequestSchema
      .optional()
      .describe(
        "The zone, record and expected state a dns read or write names (ADR 0018).",
      ),
    window: z
      .strictObject({
        since: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            "The window's start, as an ISO instant; absent is one hour before now.",
          ),
        until: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            "The window's end, as an ISO instant; absent is a live window ending now.",
          ),
      })
      .optional()
      .describe(
        "monitor only: the window the report covers; rig resolves durations such as 1h against its own clock before sending.",
      ),
    host: z
      .boolean()
      .optional()
      .describe(
        "monitor and activity: the whole Host instead of one Project. A monitor reports every Project's total, Rig itself and the Host; an activity read has every Project's records and rigd's own administration.",
      ),
  })
  .strict();
export type DnsRequest = z.infer<typeof dnsRequestSchema>;
export type RuntimeCommand = z.infer<typeof commandSchema>;
/** Reads probe committed state and are never queued behind mutations. */
export const readActions: ReadonlySet<RuntimeCommand["action"]> = new Set([
  "initialization-info",
  "deployment-context",
  "list",
  "status",
  "doctor",
  "config",
  "logs",
  "activity",
  "queue",
  "deployments",
  "proxy",
  "backups",
  "dns",
  "monitor",
] as const);
/** Replies to the reads rig prints. A missing or malformed report or
 * collection is a protocol failure, never an empty page; unknown top-level keys
 * are kept so a newer rigd can add evidence without breaking an older rig.
 * List, logs and activity items are reduced to the fields rig shows; the
 * doctor, config, proxy and DNS reports keep every field, since --json prints
 * them whole. */
export const listResultSchema = z
  .object({
    projects: z
      .array(
        z.object({
          id: z
            .string()
            .optional()
            .describe(
              "The Project's stable id, the projectId of its status and monitor series.",
            ),
          name: z.string().describe("The Project's registered name."),
          repoPath: z
            .string()
            .describe("The repository directory it is registered at."),
          targetCount: z
            .number()
            .int()
            .nonnegative()
            .describe(
              "How many Targets rigd has recorded for it, running or stopped.",
            ),
          missing: z
            .boolean()
            .optional()
            .describe(
              "The registered directory no longer exists; repoint or forget resolves it.",
            ),
        }),
      )
      .describe("Every registered Project."),
  })
  .passthrough();
export const logsResultSchema = z
  .object({
    project: z.string().describe("The Project whose logs were read."),
    target: z.string().describe("The Target's name."),
    entries: z
      .array(
        z.object({
          timestamp: z
            .string()
            .describe(
              "When the line was written (ISO 8601), or unknown for a record without a time.",
            ),
          component: z
            .string()
            .describe(
              "The Service, Tool or job that wrote it, or unknown when no record says.",
            ),
          stream: z
            .enum(["stdout", "stderr", "health", "unknown"])
            .describe(
              "stdout or stderr output, health-check evidence, or unknown for a record that does not say.",
            ),
          line: z.string().describe("The line, without its newline."),
        }),
      )
      .describe("The entries read, oldest first."),
    cursor: z
      .string()
      .describe(
        "Opaque; rig sends it back unchanged as after to read the next page.",
      ),
    filtered: z
      .boolean()
      .optional()
      .describe(
        "The read was narrowed by a filter, so no entries means none matched rather than none recorded.",
      ),
    more: z
      .boolean()
      .optional()
      .describe(
        "A first page left out older entries that match: more than lines were recorded.",
      ),
  })
  .passthrough();
export const activityResultSchema = z
  .object({
    operations: z
      .array(
        z.object({
          id: z
            .string()
            .describe(
              "The Operation's id, or a job run's id for the record of a run.",
            ),
          action: z
            .string()
            .describe(
              "What the record is about, such as deploy, crash or job.",
            ),
          outcome: z
            .string()
            .describe(
              "Its final outcome, such as started, stopped, deployed, failed or unchanged.",
            ),
          occurredAt: z.string().describe("When it ended (ISO 8601)."),
          project: z
            .string()
            .optional()
            .describe(
              "The Project's name; absent for a record about no Project, such as rigd's own administration.",
            ),
          target: z
            .string()
            .optional()
            .describe(
              "The Target's name; absent for a Project or Host record.",
            ),
          component: z
            .object({
              kind: z
                .enum(["service", "job"])
                .describe("Whether it is a Service or a job."),
              name: z.string().describe("Its name in rig.yaml."),
            })
            .optional()
            .describe(
              "The Service or Job the record is about; absent for a whole Target or Project.",
            ),
          message: z
            .string()
            .optional()
            .describe("What happened, or why it failed."),
        }),
      )
      .describe("The records kept, oldest first."),
    operation: z
      .string()
      .optional()
      .describe(
        "The Operation id (or prefix) the records were selected by, when one was.",
      ),
    total: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "How many records matched before the newest lines were kept; absent for an Operation id.",
      ),
  })
  .passthrough();
const usageStatsSchema = z.object({
  low: z.number().describe("The lowest sample."),
  high: z.number().describe("The highest sample."),
  average: z.number().describe("The mean of the samples."),
  median: z.number().describe("The median of the samples."),
  p95: z.number().describe("The 95th percentile of the samples."),
});
const usageSummarySchema = {
  cpu: usageStatsSchema
    .optional()
    .describe(
      "CPU in percent of one core, so a busy Component can read 350; absent when nothing was sampled.",
    ),
  memory: usageStatsSchema
    .optional()
    .describe("Memory in bytes; absent when nothing was sampled."),
};
/** A `monitor` reply: what a Project or the whole Host used over a window, one entry per series. */
export const monitorResultSchema = z
  .object({
    project: z
      .string()
      .optional()
      .describe("The Project reported on; absent for the Host."),
    since: z
      .number()
      .describe("The start of the window asked for, in Unix seconds."),
    until: z
      .number()
      .optional()
      .describe(
        "The end of the window asked for, in Unix seconds; absent for a live window ending now.",
      ),
    from: z
      .number()
      .describe(
        "The first point's start, in Unix seconds: since rounded down to a step.",
      ),
    to: z.number().describe("The end of the last point, in Unix seconds."),
    step: z
      .number()
      .int()
      .positive()
      .describe(
        "Seconds per point: one of Rig's fixed steps (up to a day), or a whole number of days for longer windows, sized to give the window about 360 points, and at least 60 when the points are read from per-minute history.",
      ),
    sampledEvery: z
      .number()
      .positive()
      .describe(
        "How often rigd samples, in seconds: 1 with the native reader, 5 with the ps fallback.",
      ),
    series: z
      .array(
        z.object({
          series: z
            .object({
              scope: z
                .enum(["host", "rig", "project", "target", "component"])
                .describe(
                  "What the series totals: everything Rig runs on the Host with Rig itself, Rig itself (rigd, its Caddy and the capture wrappers), one Project, one Target, or one Service or job.",
                ),
              projectId: z
                .string()
                .optional()
                .describe("The Project's stable id; absent for host and rig."),
              project: z
                .string()
                .optional()
                .describe("The Project's name; absent for host and rig."),
              targetId: z
                .string()
                .optional()
                .describe(
                  "The Target's id; present for target and component only.",
                ),
              target: z
                .string()
                .optional()
                .describe(
                  "The Target's name: working, stable or a Preview's name; present for target and component only.",
                ),
              targetKind: z
                .enum(["working", "stable", "preview"])
                .optional()
                .describe(
                  "The Target's role; present for target and component only.",
                ),
              component: z
                .string()
                .optional()
                .describe(
                  "The Service's or job's name; present for component only.",
                ),
              componentKind: z
                .enum(["service", "job"])
                .optional()
                .describe(
                  "Whether the component is a Service or a job; present for component only.",
                ),
            })
            .passthrough()
            .describe(
              "Which series this is; its ids, not its names, identify it.",
            ),
          now: z
            .object({
              cpuPercent: z
                .number()
                .describe(
                  "CPU over the last sampling interval, in percent of one core.",
                ),
              memoryBytes: z.number().describe("Memory in bytes."),
            })
            .optional()
            .describe(
              "The newest sample, while it is from the last two sampling intervals; absent once the series stopped running.",
            ),
          summary: z
            .object(usageSummarySchema)
            .describe("CPU and memory over the whole window."),
          points: z
            .array(
              z.object({
                at: z
                  .number()
                  .describe(
                    "The point's start, in Unix seconds; it lasts one step.",
                  ),
                ...usageSummarySchema,
              }),
            )
            .describe("The chart, one point per step from from to to."),
        }),
      )
      .describe(
        "One entry per series: for the Host, the Host, Rig itself and each Project by name; for a Project, the Project, then its Targets, then their Components.",
      ),
  })
  .passthrough();
export type MonitorResult = z.infer<typeof monitorResultSchema>;
/** One Service a running Operation asked to stop. */
export const serviceStopSchema = z
  .object({
    service: z.string().describe("The Service's name."),
    target: z.string().describe("The name of the Target it belongs to."),
    state: z
      .enum(["stopping", "stopped", "failed"])
      .describe(
        "stopping until its process is gone, then stopped; failed when the stop could not be verified.",
      ),
    since: z.string().describe("When the stop signal was sent (ISO 8601)."),
    killAt: z
      .string()
      .describe(
        "When SIGKILL is due (ISO 8601): the stop_timeout after since, or the kill wait once a kill was asked.",
      ),
    endedAt: z
      .string()
      .optional()
      .describe("When the process was gone (ISO 8601)."),
    killed: z
      .enum(["timeout", "request"])
      .optional()
      .describe(
        "The process needed SIGKILL: its stop_timeout ran out (timeout), or a kill cut it short (request).",
      ),
  })
  .passthrough();
export type ServiceStop = z.infer<typeof serviceStopSchema>;
const operationViewSchema = z
  .object({
    operationId: z.string().describe("The Operation's id."),
    action: z
      .string()
      .describe(
        "The command's action, or the name of a pass rigd runs itself, such as reconcile or supervise.",
      ),
    project: z
      .string()
      .optional()
      .describe("The Project it acts on, when it acts on one."),
    target: z
      .string()
      .optional()
      .describe("The Target it acts on, when it acts on one."),
    phase: z
      .string()
      .describe(
        "What the Operation is doing now, such as starting, stopping, deploying or reconciling; stopping while it waits for a Service to exit.",
      ),
    startedAt: z.string().describe("When it started (ISO 8601)."),
    stops: z
      .array(serviceStopSchema)
      .optional()
      .describe(
        "The Services the Operation has asked to stop so far, in the order it asked; absent before its first stop.",
      ),
  })
  .passthrough();
/** The part of the `queue` read a waiting command renders: where its own Operation stands. */
export const queueResultSchema = z
  .object({
    operation: z
      .discriminatedUnion("state", [
        z
          .object({
            state: z.literal("running").describe("The Operation is running."),
            phase: z
              .string()
              .describe(
                "What the Operation is doing now, such as starting, stopping, deploying or reconciling; stopping while it waits for a Service to exit.",
              ),
            project: z
              .string()
              .optional()
              .describe("The Project it acts on, when it acts on one."),
            target: z
              .string()
              .optional()
              .describe("The Target it acts on, when it acts on one."),
            stops: z
              .array(serviceStopSchema)
              .optional()
              .describe(
                "The Services the Operation has asked to stop so far, in the order it asked; absent before its first stop.",
              ),
          })
          .passthrough(),
        z
          .object({
            state: z
              .literal("waiting")
              .describe("The Operation waits in rigd's queue."),
            waitingOn: z
              .array(operationViewSchema)
              .describe("The Operations it waits behind."),
            ahead: z
              .number()
              .int()
              .nonnegative()
              .describe(
                "How many more Operations are queued before it on the same Target or Project.",
              ),
          })
          .passthrough(),
        z
          .object({
            state: z
              .literal("unknown")
              .describe(
                "rigd runs or holds no Operation of that id: it has ended, or never reached rigd.",
              ),
          })
          .passthrough(),
      ])
      .optional()
      .describe(
        "Where the Operation the read named stands; absent when it named none.",
      ),
  })
  .passthrough();
export type QueueResult = z.infer<typeof queueResultSchema>;
/** One kept backup as `rig backup list` and the dashboard show it. */
export const backupReportSchema = z
  .object({
    target: z.string().describe("The Target's name."),
    job: z.string().describe("The backup job's name."),
    id: z
      .string()
      .describe(
        "The backup's id: its run's start in UTC and its number in the job's backup sequence, such as 20261011T030000Z-17; never issued twice.",
      ),
    path: z.string().describe("Its directory under RIG_ROOT/backups."),
    run: z
      .string()
      .describe("The run that wrote it, as rig activity names it."),
    trigger: z
      .enum(["schedule", "manual"])
      .describe("Whether the schedule or rig run started that run."),
    startedAt: z.string().describe("When its run started (ISO 8601)."),
    finishedAt: z.string().describe("When its run ended (ISO 8601)."),
    bytes: z
      .number()
      .int()
      .optional()
      .describe("Its size in bytes; absent until it was measured."),
    missing: z
      .literal(true)
      .optional()
      .describe(
        "Its directory is gone (deleted by hand), so it cannot be restored.",
      ),
  })
  .passthrough();
export const backupsResultSchema = z
  .object({
    project: z.string().describe("The Project the backups belong to."),
    backups: z
      .array(backupReportSchema)
      .describe(
        "Newest first. A command that names a job or Target lists only its backups.",
      ),
  })
  .passthrough();
/** A `doctor` reply. `rig doctor` exits 1 unless `ok` is true. */
export const doctorResultSchema = z
  .object({
    ok: z.boolean().describe("Every check passed."),
    checks: z
      .array(
        z
          .object({
            name: z.string().describe("What was checked, such as rigd."),
            ok: z.boolean().describe("The check passed."),
            message: z.string().describe("What the check found."),
            reason: z
              .string()
              .optional()
              .describe("A stable word for why it failed."),
            hint: z.string().optional().describe("What to do about a failure."),
          })
          .passthrough(),
      )
      .readonly()
      .describe("Every check run."),
    project: z
      .string()
      .optional()
      .describe(
        "The Project whose checks are included; absent when only the Host was checked.",
      ),
    note: z.string().optional().describe("Why Project checks are absent."),
  })
  .passthrough();
/** A `config` reply: the Project's validated rig.yaml and where it is. */
export const configResultSchema = z
  .object({
    project: z.string().describe("The Project's registered name."),
    path: z.string().describe("The rig.yaml read."),
    revision: z
      .string()
      .describe(
        "A digest of its text, which an edit names to be applied only to that text.",
      ),
    config: z.record(z.string(), z.unknown()).describe("The validated config."),
  })
  .passthrough();
const proxyUpstream = z
  .string()
  .nullable()
  .describe(
    "The loopback address a path reaches; null while it is withheld and answers 503.",
  );
/** A `proxy` reply: Rig's Caddy and every hostname it serves. */
export const proxyResultSchema = z
  .object({
    caddy: z
      .object({
        state: z
          .string()
          .describe(
            "running, unreachable (runs, or may, but does not answer) or stopped.",
          ),
        binary: z
          .string()
          .optional()
          .describe(
            "The Caddy executable the job runs, under the Rig root; absent before one is installed.",
          ),
        ports: z
          .object({
            http: z.number().int().describe("The port Caddy serves HTTP on."),
            https: z.number().int().describe("The port Caddy serves HTTPS on."),
          })
          .passthrough()
          .describe(
            "The ports of the settings Caddy accepted. Before the first generation, the ports Host config asks for, or 80 and 443 when it cannot be read.",
          ),
        ca: z
          .string()
          .describe(
            "Where its certificates come from, as the accepted settings say; unknown before the first generation when Host config cannot be read.",
          ),
        generation: z
          .string()
          .optional()
          .describe("The served generation; absent before the first."),
      })
      .passthrough()
      .describe(
        "Rig's Caddy: its job, and the ports and CA of the settings it accepted, or of Host config before the first generation.",
      ),
    sites: z
      .array(
        z.discriminatedUnion("source", [
          z
            .object({
              hostname: z.string().describe("The hostname served."),
              source: z
                .literal("target")
                .describe("A Target's route, published from its plan."),
              project: z.string().describe("The Project's name."),
              target: z.string().describe("The Target's name."),
              routes: z
                .array(
                  z
                    .object({
                      prefix: z
                        .string()
                        .describe(
                          "The path prefix, such as / or /api; a request takes the longest that matches.",
                        ),
                      upstream: proxyUpstream,
                    })
                    .passthrough(),
                )
                .readonly()
                .describe("The hostname's paths, in matching order."),
              certificate: z
                .string()
                .optional()
                .describe(
                  "The certificate subject that covers the hostname, its own or a wildcard; absent for a plain HTTP site, an IP address, localhost, and a wildcard hostname, which the report does not name a certificate for.",
                ),
            })
            .passthrough(),
          z
            .object({
              hostname: z.string().describe("The hostname served."),
              source: z
                .literal("custom")
                .describe(
                  "One of the owner's own routes, from proxy.routes in Host config, or the dashboard's.",
                ),
              upstream: proxyUpstream,
              certificate: z
                .string()
                .optional()
                .describe(
                  "The certificate subject that covers the hostname, its own or a wildcard; absent for a plain HTTP site, an IP address, localhost, and a wildcard hostname, which the report does not name a certificate for.",
                ),
            })
            .passthrough(),
        ]),
      )
      .readonly()
      .describe(
        "Every hostname Caddy serves, by hostname, as the current generation serves it.",
      ),
    pending: z
      .object({
        fields: z
          .array(z.string())
          .readonly()
          .describe(
            "The top-level proxy fields that differ from what is served, such as routes or tls; empty when Host config cannot be read.",
          ),
        reason: z
          .string()
          .describe("Why Rig refused them, or that they are not applied yet."),
        code: z
          .string()
          .optional()
          .describe("The refusal's error code, when Rig refused them."),
      })
      .passthrough()
      .optional()
      .describe("Host config proxy settings Caddy does not serve, and why."),
  })
  .passthrough();
/** A `dns` reply (ADR 0018): the zones Rig manages, their records, and where each served hostname points. */
export const dnsResultSchema = z
  .object({
    provider: z
      .string()
      .describe(
        "The DNS provider proxy.tls.dns in Host config names, such as cloudflare.",
      ),
    address: z
      .string()
      .optional()
      .describe("This Mac's IPv4 address, when Rig knows it."),
    addressSource: z
      .enum(["config", "tailscale"])
      .optional()
      .describe(
        "Where the address came from: proxy.dns.address in Host config, or Tailscale.",
      ),
    zones: z
      .array(
        z
          .object({
            id: z.string().describe("The provider's id for the zone."),
            name: z
              .string()
              .describe(
                "The zone's apex name, lowercase, such as example.com.",
              ),
            status: z
              .string()
              .describe(
                "The provider's word for the zone's state, such as active or pending.",
              ),
          })
          .passthrough(),
      )
      .readonly()
      .describe(
        "The zones reported: the one asked for, or every zone whose records were read.",
      ),
    unseenZones: z
      .array(z.string())
      .readonly()
      .optional()
      .describe("Zones proxy.dns.zones names that the token cannot see."),
    unreadableZones: z
      .array(
        z
          .object({
            zone: z.string().describe("The zone's name."),
            code: z.string().describe("The error code its read failed with."),
            message: z.string().describe("Why its read failed."),
          })
          .passthrough(),
      )
      .readonly()
      .optional()
      .describe(
        "Zones whose records could not be read, reported beside the rest; a zone asked for by name is never among them, since its read fails instead.",
      ),
    records: z
      .array(
        z
          .object({
            id: z.string().describe("The provider's id for the record."),
            zone: z.string().describe("The name of the zone it belongs to."),
            name: z
              .string()
              .describe(
                "Fully qualified, lowercase, without a trailing dot; a wildcard starts with *.",
              ),
            type: z
              .string()
              .describe(
                "A, AAAA, CNAME, TXT, MX or CAA, or another type Rig only lists.",
              ),
            content: z
              .string()
              .describe(
                "The record's value: an address, a hostname or text, by type.",
              ),
            ttl: z
              .number()
              .describe("Seconds; 1 means the provider's automatic TTL."),
            proxied: z
              .boolean()
              .optional()
              .describe(
                "Answered by the provider's proxy edge rather than with content; only A, AAAA and CNAME can be.",
              ),
            priority: z
              .number()
              .optional()
              .describe("MX preference; lower is preferred."),
            comment: z
              .string()
              .optional()
              .describe("The note kept with the record."),
            modifiedOn: z
              .string()
              .describe(
                "When the provider last changed it (ISO 8601); a write that names this value is refused once it differs.",
              ),
          })
          .passthrough(),
      )
      .readonly()
      .describe("Every record of the zones reported, by name and then type."),
    hostnames: z
      .array(
        z
          .object({
            hostname: z.string().describe("A hostname Rig's Caddy serves."),
            zone: z
              .string()
              .optional()
              .describe(
                "The longest zone Rig manages that holds it, when a visible one does.",
              ),
            verdict: z.string().describe("mac, elsewhere, missing or unknown."),
            wildcard: z
              .boolean()
              .describe("Only a wildcard record answers for it."),
            chain: z
              .array(z.string())
              .readonly()
              .describe("The CNAME hops followed, each name -> target."),
            reason: z
              .string()
              .describe("One sentence saying why the verdict is what it is."),
            fix: z
              .object({
                op: z
                  .string()
                  .describe("create or update: how the fix changes the zone."),
                record: z
                  .object({
                    name: z.string().describe("The record's name."),
                    content: z
                      .string()
                      .describe("The address it is pointed at."),
                  })
                  .passthrough()
                  .describe("The record the fix writes."),
              })
              .passthrough()
              .optional()
              .describe(
                "The one change Point at this Mac makes, when one simple change does it.",
              ),
            fixBlocked: z
              .string()
              .optional()
              .describe(
                "Why no one-click change is offered for a hostname that does not point here.",
              ),
            unreadZone: z
              .string()
              .optional()
              .describe(
                "The zone whose records could not be read, when that is why the verdict is unknown.",
              ),
          })
          .passthrough(),
      )
      .readonly()
      .describe(
        "Where each hostname Rig's Caddy serves points now: the Targets' hostnames and proxy.routes. A read of one zone keeps those that zone owns; a read of every zone keeps them all, and one in no zone Rig manages has no zone and the verdict unknown.",
      ),
  })
  .passthrough();
export type BackupReport = z.infer<typeof backupReportSchema>;
export type BackupsResult = z.infer<typeof backupsResultSchema>;
export type ListResult = z.infer<typeof listResultSchema>;
export type LogsResult = z.infer<typeof logsResultSchema>;
export type ActivityResult = z.infer<typeof activityResultSchema>;
export const readResultSchemas = {
  list: listResultSchema,
  logs: logsResultSchema,
  activity: activityResultSchema,
  backups: backupsResultSchema,
  monitor: monitorResultSchema,
  doctor: doctorResultSchema,
  config: configResultSchema,
  proxy: proxyResultSchema,
  dns: dnsResultSchema,
} as const;
export interface DaemonAddress {
  port: number;
  token: string;
}
export interface DaemonHealth {
  instanceId: string;
  pid: number;
  running: true;
  /** Absent when an older rigd, which reported none, is serving. */
  version?: string;
  /** Where rigd serves the dashboard; absent when it runs none. */
  dashboard?: string;
  /** Why the dashboard is not served as Host config asks: why it is not served, why a dashboard an earlier rigd left
   * running is not stopped yet, or, while it is served, that Host config asks for another address than the one Rig's Caddy
   * accepted. Absent when none of these holds. */
  dashboardProblem?: string;
}
