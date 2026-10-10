import { isAbsolute } from "node:path";
import { z } from "zod";

/** Only domain commands cross the local control plane, never arbitrary scripts. */
/** The names rig checks before sending, so a bad flag is named instead of read as version skew. */
export const projectName = z.string().min(1).max(128);
export const previewName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
/** A component name `rig logs --service` may send: the shape every Service and Tool name has. Like config, it sets no
 * length limit of its own; the control plane's request size bounds it. */
export const logComponentName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
/** rig resolves paths against the caller's directory before sending; rigd never resolves against its own. */
export const absolutePath = z.string().min(1).refine(isAbsolute, {
  message: "must be an absolute path",
});
export const commandSchema = z
  .object({
    action: z.enum([
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
      "queue",
      "deployments",
    ]),
    operationId: z.string().min(1).max(128).optional(),
    project: projectName.optional(),
    repoPath: absolutePath.optional(),
    /** `working`, `stable` or `preview`; the daemon reads none as `working`. */
    target: z.string().min(1).max(63).optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    deployment: previewName.optional(),
    domain: z.string().optional(),
    service: z
      .object({
        name: z.string(),
        command: z.string(),
        port: z.number().int().optional(),
        healthcheck: z.string().optional(),
      })
      .strict()
      .optional(),
    tool: z
      .object({
        name: z.string(),
        bin: z.string(),
        build: z.string().optional(),
      })
      .strict()
      .optional(),
    createGit: z.boolean().optional(),
    productionBranch: z.string().optional(),
    force: z.boolean().optional(),
    noUp: z.boolean().optional(),
    /** Skip each Service's stop_timeout: SIGTERM, then SIGKILL after the kill wait; a stop already running on the Target is
     * cut short too. */
    kill: z.boolean().optional(),
    lines: z.number().int().min(1).max(10000).optional(),
    /** Narrows a logs read; absent reads every entry. `lines` counts the entries it keeps. */
    logFilter: z
      .strictObject({
        /** Component names; rigd refuses a name the Target does not have. */
        services: z.array(logComponentName).min(1).max(64).optional(),
        stream: z.enum(["stdout", "stderr"]).optional(),
        /** Inclusive ISO instants; rig resolves durations such as 1h against its own clock before sending. */
        since: z.iso.datetime({ offset: true }).optional(),
        until: z.iso.datetime({ offset: true }).optional(),
      })
      .optional(),
    /** An Operation id (or unambiguous prefix) that activity narrows to; the id a failed command prints. */
    operation: z.string().min(1).optional(),
    after: z.string().optional(),
    newName: z.string().optional(),
    newPath: absolutePath.optional(),
  })
  .strict();
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
] as const);
/** Replies to the reads whose collections rig renders. A missing or malformed
 * collection is a protocol failure, never an empty page; unknown top-level keys
 * are kept so a newer rigd can add evidence without breaking an older rig,
 * while each collection item is reduced to the fields rig shows. */
export const listResultSchema = z
  .object({
    projects: z.array(
      z.object({
        name: z.string(),
        repoPath: z.string(),
        targetCount: z.number().int().nonnegative(),
        /** The registered directory no longer exists; repoint or forget resolves it. */
        missing: z.boolean().optional(),
      }),
    ),
  })
  .passthrough();
export const logsResultSchema = z
  .object({
    project: z.string(),
    target: z.string(),
    entries: z.array(
      z.object({
        timestamp: z.string(),
        component: z.string(),
        stream: z.enum(["stdout", "stderr", "health", "unknown"]),
        line: z.string(),
      }),
    ),
    /** Opaque; rig sends it back unchanged as `after` to read the next page. */
    cursor: z.string(),
    /** The read was narrowed by a filter, so no entries means none matched rather than none recorded. */
    filtered: z.boolean().optional(),
  })
  .passthrough();
export const activityResultSchema = z
  .object({
    operations: z.array(
      z.object({
        id: z.string(),
        action: z.string(),
        outcome: z.string(),
        occurredAt: z.string(),
        project: z.string().optional(),
        target: z.string().optional(),
        message: z.string().optional(),
      }),
    ),
    /** The Operation id (or prefix) the records were selected by, when one was. */
    operation: z.string().optional(),
  })
  .passthrough();
/** One Service a running Operation asked to stop. */
export const serviceStopSchema = z
  .object({
    service: z.string(),
    target: z.string(),
    state: z.enum(["stopping", "stopped", "failed"]),
    since: z.string(),
    killAt: z.string(),
    endedAt: z.string().optional(),
    killed: z.enum(["timeout", "request"]).optional(),
  })
  .passthrough();
export type ServiceStop = z.infer<typeof serviceStopSchema>;
const operationViewSchema = z
  .object({
    operationId: z.string(),
    action: z.string(),
    project: z.string().optional(),
    target: z.string().optional(),
    phase: z.string(),
    startedAt: z.string(),
    stops: z.array(serviceStopSchema).optional(),
  })
  .passthrough();
/** The part of the `queue` read a waiting command renders: where its own Operation stands. */
export const queueResultSchema = z
  .object({
    operation: z
      .discriminatedUnion("state", [
        z
          .object({
            state: z.literal("running"),
            phase: z.string(),
            project: z.string().optional(),
            target: z.string().optional(),
            stops: z.array(serviceStopSchema).optional(),
          })
          .passthrough(),
        z
          .object({
            state: z.literal("waiting"),
            waitingOn: z.array(operationViewSchema),
            ahead: z.number().int().nonnegative(),
          })
          .passthrough(),
        z.object({ state: z.literal("unknown") }).passthrough(),
      ])
      .optional(),
  })
  .passthrough();
export type QueueResult = z.infer<typeof queueResultSchema>;
export type ListResult = z.infer<typeof listResultSchema>;
export type LogsResult = z.infer<typeof logsResultSchema>;
export type ActivityResult = z.infer<typeof activityResultSchema>;
export const readResultSchemas = {
  list: listResultSchema,
  logs: logsResultSchema,
  activity: activityResultSchema,
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
}
