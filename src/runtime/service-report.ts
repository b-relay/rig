import type { ComponentReport, ServiceHealth } from "../domain/project-status";
import type { ManagedComponent } from "../config/types";
import { currentRun, type TargetRecord } from "../domain/runtime";
import { supervisionScope } from "../domain/restart-policy";
import { runningNote, stoppedStanding } from "../domain/restart-wording";
import type { ProcessObservation } from "../providers/contracts";
import type { HealthResults } from "./health-monitor";
import {
  healthRestartDueAt,
  healthStartPending,
} from "../domain/health-policy";
import { rigCommand } from "../domain/rig-command";

/** What a Component's report says before anything is observed of it. */
export type ComponentBase = Pick<
  ComponentReport,
  "name" | "kind" | "port" | "ports" | "restarts" | "route" | "hostnames"
>;

/** How a running Service's health stands: its report state, with the health monitor's view and why, when it has them. */
export type HealthStanding = Pick<ComponentReport, "state" | "reason"> & {
  health?: ServiceHealth;
};

/** Pure: the report of a Service whose process does not run. A stopped one says how it ended and what Rig does about it, or
 * that it waits for its next health restart; an unknown one says why it could not be told. */
export function notRunningServiceReport(
  target: TargetRecord,
  component: ManagedComponent,
  base: ComponentBase,
  observed: ProcessObservation,
): ComponentReport {
  if (observed.state !== "stopped")
    return {
      ...base,
      state: observed.state,
      port: component.port,
      ...(observed.reason ? { reason: observed.reason } : {}),
    };
  const waiting = healthRestartWaiting(target, component);
  if (waiting)
    return {
      ...base,
      port: component.port,
      ...waiting,
      ...(observed.reason
        ? { reason: `${observed.reason} ${waiting.reason}` }
        : {}),
    };
  const standing = stoppedStanding(
    target,
    component,
    observed,
    supervisionScope(target),
  );
  const reason = [observed.reason, standing.reason].filter(Boolean).join(" ");
  return {
    ...base,
    ...standing,
    port: component.port,
    ...(reason ? { reason } : {}),
  };
}

/** Pure: the report of a Service whose process runs, as `health` says it stands. A running Service can still have something
 * to say, such as output it cannot record or an unknown exit it was started again after; a Service a deploy kept shows the
 * Commit it runs from. */
export function runningServiceReport(
  target: TargetRecord,
  component: ManagedComponent,
  base: ComponentBase,
  observed: ProcessObservation,
  health: HealthStanding,
): ComponentReport {
  const said = [observed.reason, runningNote(target, component, observed)]
    .filter(Boolean)
    .join(" ");
  const reason = [said, health.reason].filter(Boolean).join(" ");
  const commit = runningCommit(target, component.name, observed);
  return {
    ...base,
    port: component.port,
    pid: observed.pid,
    ...(commit ? { commit } : {}),
    state: health.state,
    ...(health.health ? { health: health.health } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Pure: the Commit the running process of `service` was started from, while it is the process its run names; a Service a
 * deploy kept runs from an earlier Commit than its Target's (ADR 0016). */
export function runningCommit(
  target: Pick<TargetRecord, "services" | "plan">,
  service: string,
  observed: Pick<ProcessObservation, "incarnation">,
): string | undefined {
  const run = currentRun(target, service);
  return run?.incarnation !== undefined &&
    observed.incarnation === run.incarnation
    ? run.source?.commit
    : undefined;
}

/** Pure: how a running Service with a healthcheck stands by the health monitor's cached checks: running until one answered,
 * then healthy or unhealthy, with why and what Rig does about it. Undefined without a healthcheck or without `results`,
 * when no monitor runs, so the caller checks it itself. */
export function monitoredHealth(
  target: Pick<TargetRecord, "id" | "name">,
  component: ManagedComponent,
  results: HealthResults | undefined,
): (HealthStanding & { health: ServiceHealth }) | undefined {
  const policy = component.healthcheck;
  if (!policy || !results) return undefined;
  const health: ServiceHealth = results(target, component.name) ?? {
    status: "starting",
    failures: 0,
    retries: policy.retries,
    restarts: 0,
  };
  const checks = (count: number) =>
    `${count} health ${count === 1 ? "check" : "checks"}`;
  const output = health.output ? ` (${health.output})` : "";
  if (health.status === "starting")
    return {
      state: "running",
      health,
      reason: "Its healthcheck has not answered since it started.",
    };
  if (health.status === "healthy")
    return {
      state: "healthy",
      health,
      ...(health.failures
        ? {
            reason: `${checks(health.failures)} in a row failed${output}; it is unhealthy after ${health.retries}.`,
          }
        : {}),
    };
  const failed = health.failures
    ? `${checks(health.failures)} in a row failed${output}`
    : `It became unhealthy${output}, and no check has passed since`;
  return {
    state: "unhealthy",
    health,
    reason:
      policy.onFailure === "restart"
        ? `${failed}. Rig restarts it${health.restarts ? ` (${health.restarts} health ${health.restarts === 1 ? "restart" : "restarts"} so far)` : ""}.`
        : `${failed}. Its healthcheck's on_failure is report, so Rig reports it and does not restart it.`,
  };
}

/** A Service its health restart stopped and could not start again: unhealthy, and waiting for the next health restart on
 * the back-off. Undefined for any other stopped Service. */
function healthRestartWaiting(
  target: TargetRecord,
  component: ManagedComponent,
): (HealthStanding & { health: ServiceHealth }) | undefined {
  const run = currentRun(target, component.name);
  if (
    target.desired !== "running" ||
    component.healthcheck?.onFailure !== "restart" ||
    !healthStartPending(run)
  )
    return undefined;
  const stretch = run.healthStretch;
  return {
    state: "unhealthy",
    health: {
      status: "unhealthy",
      failures: 0,
      retries: component.healthcheck.retries,
      restarts: stretch.restarts.length,
      restartFailed: true,
      nextRestartAt: new Date(healthRestartDueAt(stretch)).toISOString(),
    },
    reason: `Its health restart ${stretch.restarts.length} did not leave it running (its start failed the start check, or the restart was cut short), so it is stopped. Rig starts it again at its next health restart (${new Date(healthRestartDueAt(stretch)).toISOString()}), whatever its restart policy; run ${rigCommand("restart", { target })} to start it now, or ${rigCommand("down", { target })} to stop trying.`,
  };
}
