import type { ComponentReport } from "./project-status";

/* Schema-free, so the dashboard's browser code formats health without loading the status report's schemas. */

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
