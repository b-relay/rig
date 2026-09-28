import { DEFAULT_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
import type { PlanComponent, RestartPolicy, TargetPlan } from "./types";

/** When Rig starts a Service again after a known exit, when its config sets no `restart`. */
export const DEFAULT_RESTART_POLICY: RestartPolicy = "always";
/** An ongoing check's time limit, failures in a row before Rig acts, and what it does then, when health sets none. */
export const DEFAULT_HEALTH_TIMEOUT_SECONDS = 5;
export const DEFAULT_HEALTH_FAILURES = 3;
export const DEFAULT_HEALTH_ON_FAILURE = "report" as const;

/** A recorded plan with every field a later rigd added and a plan recorded before it lacks filled with the value the
 * planner gives when config does not set it: a managed Service's `stopTimeout` and `restart`. A plan recorded before such a
 * field existed then equals the plan the planner makes today from the same config; a value the plan did record is kept, so
 * a config that sets a non-default one still differs. The recorded plan is not changed. Add a field here whenever the
 * planner starts writing one that recorded plans may lack and whose absence means that default. */
export function withPlanDefaults(plan: TargetPlan): TargetPlan {
  return { ...plan, components: plan.components.map(withComponentDefaults) };
}
function withComponentDefaults(component: PlanComponent): PlanComponent {
  if (component.kind !== "managed") return component;
  return {
    ...component,
    stopTimeout: component.stopTimeout ?? DEFAULT_STOP_TIMEOUT_SECONDS,
    restart: component.restart ?? DEFAULT_RESTART_POLICY,
  };
}
