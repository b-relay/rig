import { z } from "zod";

/** Only domain commands cross the local control plane, never arbitrary scripts. */
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
    ]),
    operationId: z.string().min(1).max(128).optional(),
    project: z.string().min(1).max(128).optional(),
    repoPath: z.string().min(1).optional(),
    target: z.enum(["local", "live", "preview"]).optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    deployment: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .optional(),
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
    after: z.string().optional(),
    newName: z.string().optional(),
    newPath: z.string().optional(),
  })
  .strict();
export type RuntimeCommand = z.infer<typeof commandSchema>;
export interface DaemonAddress {
  port: number;
  token: string;
}
export interface DaemonHealth {
  instanceId: string;
  pid: number;
  running: true;
}
