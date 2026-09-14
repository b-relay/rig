import { z } from "zod";

/** Only domain commands cross the local control plane, never arbitrary scripts. */
/** The names rig checks before sending, so a bad flag is named instead of read as version skew. */
export const projectName = z.string().min(1).max(128);
export const previewName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
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
      "git-push",
      "destroy",
      "prepare-uninstall",
      "cancel-uninstall",
      "queue",
    ]),
    operationId: z.string().min(1).max(128).optional(),
    project: projectName.optional(),
    repoPath: z.string().min(1).optional(),
    target: z.enum(["local", "live", "preview"]).optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    deployment: previewName.optional(),
    domain: z.string().optional(),
    proxy: z.string().optional(),
    uses: z.array(z.enum(["sqlite", "postgres", "convex"])).optional(),
    managed: z
      .object({
        name: z.string(),
        command: z.string(),
        port: z.number().int().optional(),
        health: z.string().optional(),
      })
      .strict()
      .optional(),
    installed: z
      .object({
        name: z.string(),
        entrypoint: z.string(),
        build: z.string().optional(),
        installName: z.string().optional(),
      })
      .strict()
      .optional(),
    createGit: z.boolean().optional(),
    productionBranch: z.string().optional(),
    force: z.boolean().optional(),
    noUp: z.boolean().optional(),
    lines: z.number().int().min(1).max(10000).optional(),
    /** An Operation id (or unambiguous prefix) that activity narrows to; the id a failed command prints. */
    operation: z.string().min(1).optional(),
    after: z.string().optional(),
    newName: z.string().optional(),
    newPath: z.string().optional(),
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
] as const);
/** Replies to the reads whose collections rig renders. A missing or malformed
 * collection is a protocol failure, never an empty page; unknown top-level keys
 * are kept so a newer rigd can add evidence without breaking an older rig,
 * while each collection item is reduced to the fields rig shows. */
export const listResultSchema = z
  .object({
    ownership: z.enum(["ready", "unknown"]),
    projects: z.array(
      z.object({
        name: z.string(),
        repoPath: z.string(),
        targetCount: z.number().int().nonnegative(),
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
