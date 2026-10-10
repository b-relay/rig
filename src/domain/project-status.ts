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
      .describe("Configured or recorded route, even while stopped."),
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
const targetReportSchema = z
  .object({
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
    route: z.string().optional().describe("Recorded Target route."),
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
    routePublished: z
      .boolean()
      .optional()
      .describe(
        "False when the host Caddy does not load Rig's route file, so the route is inert; absent when published or unknown.",
      ),
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
  /** `working`, `stable` or `preview`; none selects every Target. */
  target?: string;
  deployment?: string;
  branch?: string;
  operationId?: string;
}
export interface ProjectStatusReader {
  status(selection: StatusSelection): Promise<ProjectStatusReport>;
}
/** A Service's state as its cached health check result says, on one line, the way `rig status` and the dashboard show it:
 * `healthy · checked 12s ago`, `healthy · 1/3 failed · checked 4s ago`, `unhealthy 3/3 · HTTP 503 · restarted 2 times`.
 * Undefined for a Service with no such result, or one in any other state. The output is shown as rigd recorded it, already
 * one line of at most 200 characters; a terminal caller still makes it safe to print. */
export function healthSummary(
  component: Pick<ComponentReport, "state" | "health">,
  now: Date,
): string | undefined {
  const health = component.health;
  if (!health || !["healthy", "unhealthy"].includes(component.state))
    return undefined;
  if (health.restartFailed)
    return [
      "unhealthy",
      "restart failed its start check",
      health.nextRestartAt
        ? Date.parse(health.nextRestartAt) <= now.getTime()
          ? "next attempt now"
          : `next attempt in ${until(health.nextRestartAt, now)}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  if (component.state === "healthy")
    return [
      "healthy",
      health.failures ? `${health.failures}/${health.retries} failed` : "",
      health.checkedAt ? `checked ${ago(health.checkedAt, now)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return [
    health.failures
      ? `unhealthy ${health.failures}/${health.retries}`
      : "unhealthy",
    health.output ?? "",
    health.restarts
      ? `restarted ${health.restarts} ${health.restarts === 1 ? "time" : "times"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
/** "45s", "5m", "1h": how long until `at`. */
function until(at: string, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(at) - now.getTime()) / 1000),
  );
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
/** "12s ago", "3m ago", "2h ago". */
function ago(at: string, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(at)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "at an unknown time";
  if (seconds < 120) return `${seconds}s ago`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
