import { z } from "zod";

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
        "stopped",
        "failed",
        "installed",
        "missing",
        "ready",
      ])
      .describe(
        "Observed capability state; configured alone is not runtime evidence.",
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
    route: z
      .string()
      .optional()
      .describe("Configured or recorded route, even while stopped."),
    exitCode: z
      .number()
      .int()
      .optional()
      .describe("Observed process exit evidence."),
    reason: z.string().optional().describe("Explanation of the observation."),
  })
  .passthrough();
const targetReportSchema = z
  .object({
    name: z.string().describe("Target identity used for selection."),
    kind: z
      .enum(["local", "live", "preview"])
      .describe("Working copy, Stable, or Preview Target."),
    state: z
      .enum([
        "configured",
        "unknown",
        "healthy",
        "unhealthy",
        "running",
        "starting",
        "stopped",
        "failed",
        "ready",
        "degraded",
      ])
      .describe(
        "Aggregate Target state without replacing individual observations.",
      ),
    branch: z.string().optional().describe("Recorded source Branch."),
    commit: z.string().optional().describe("Recorded source Commit."),
    route: z.string().optional().describe("Recorded Target route."),
    components: z
      .array(componentReportSchema)
      .describe("Configured and observed component capabilities."),
  })
  .passthrough();
export const projectStatusSchema = z
  .object({
    project: z.string().describe("Registered Project identity."),
    targets: z
      .array(targetReportSchema)
      .describe("Available Targets; an empty array is valid."),
    warnings: z
      .array(z.string())
      .optional()
      .describe(
        "Project configuration or recovery warnings; older replies may omit them.",
      ),
  })
  .passthrough();
export type ComponentReport = z.infer<typeof componentReportSchema>;
export type TargetReport = z.infer<typeof targetReportSchema>;
export type ProjectStatusReport = z.infer<typeof projectStatusSchema>;
export interface StatusSelection {
  project?: string;
  repoPath?: string;
  target?: "local" | "live" | "preview";
  deployment?: string;
  branch?: string;
  operationId?: string;
}
export interface ProjectStatusReader {
  status(selection: StatusSelection): Promise<ProjectStatusReport>;
}
