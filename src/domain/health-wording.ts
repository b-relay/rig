import type { ServiceActivity } from "./activity";
import type { HealthPolicy, HealthState } from "./health-policy";
import { rigCommand, type RecordedTarget } from "./rig-command";
import type { TargetRecord } from "./runtime";

/** What Activity and notices say about a Service's ongoing health checks. */

/** Activity for a Service that became unhealthy in `state`. */
export function unhealthyActivity(
  service: string,
  state: HealthState,
  policy: Pick<HealthPolicy, "onFailure">,
  target: RecordedTarget,
): ServiceActivity {
  return {
    action: "health",
    outcome: "failed",
    message: `${service} is unhealthy: ${state.failures} health ${state.failures === 1 ? "check" : "checks"} in a row failed (${state.output ?? "no output"}). ${
      policy.onFailure !== "restart"
        ? "Its healthcheck's on_failure is report, so Rig only reports it."
        : state.incarnation === undefined
          ? `Rig cannot restart it for its health, since a rigd too old to record which process it is started it; run ${rigCommand("restart", { target })} once.`
          : "Rig restarts it."
    }`,
  };
}

/** Activity for a Service whose health check passed again. */
export function recoveredActivity(service: string): ServiceActivity {
  return {
    action: "health",
    outcome: "unchanged",
    message: `${service} is healthy again: its health check passed.`,
  };
}

/** Activity for `dropped` changes of health not recorded while the state could not be written. */
export function droppedActivity(
  service: string,
  dropped: number,
): ServiceActivity {
  return {
    action: "health",
    outcome: "unchanged",
    message: `${service}: ${dropped} earlier ${dropped === 1 ? "change" : "changes"} of health ${dropped === 1 ? "was" : "were"} not recorded, as Rig could not write its state.`,
  };
}

/** How a Service is named to the operator: `web on stable of demo`. */
export function namedService(
  target: Pick<TargetRecord, "name" | "plan">,
  service: string,
): string {
  return `${service} on ${target.name} of ${target.plan.project}`;
}

/** The work of checking a Service's health, as the operator reads it. */
export function checkingHealth(
  target: Pick<TargetRecord, "name" | "plan">,
  service: string,
): string {
  return `Checking the health of ${namedService(target, service)}`;
}
