import type { ComponentReport, TargetReport } from "../domain/project-status";
export type { ComponentReport, TargetReport } from "../domain/project-status";
import {
  boundedObservations,
  type ObservationDeadline,
} from "./bounded-observations";
import type {
  InstalledComponent,
  ManagedComponent,
  PersistentComponent,
} from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import { runningNote, stoppedStanding, supervisionScope } from "./supervision";
import type { HealthCheck, ProcessObservation } from "../providers/contracts";
import type { ServiceHealth } from "../domain/project-status";
import type { HealthResults } from "./health-monitor";
export interface ObservationEffects {
  process(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<ProcessObservation>;
  /** Runs the Service's check once; a shell check is cut off after `timeoutMs` (2 s when absent). */
  health(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<HealthCheck>;
  artifact(
    target: TargetRecord,
    component: InstalledComponent,
    signal: AbortSignal,
  ): Promise<"installed" | "missing" | "unknown">;
  persistent(
    target: TargetRecord,
    component: PersistentComponent,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** The Service's recorded ports, its separate Convex site port included, that accept a connection right now, in
   * ascending order. Says nothing of who listens; an aborted probe counts as not listening. */
  listening(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<number[]>;
}
/** Read-only observations share one deadline; unresponsive adapters cannot extend the request budget.
 * The caller chooses the budget and the deadline scheduler, so a test can expire an observation deterministically. */
export async function observeTargets(
  targets: readonly TargetRecord[],
  effects: ObservationEffects,
  budgetMs: number,
  deadline: ObservationDeadline,
  /** The health monitor's cached results. A running Service with health.interval is judged by them and its check is not
   * run; without them it is checked here as one without an interval is. */
  health?: HealthResults,
): Promise<TargetReport[]> {
  const entries = targets.flatMap((target) =>
    target.plan.components.map((component) => ({
      target,
      component,
      base: {
        name: component.name,
        kind: component.kind,
        ...(component.kind === "managed" ? { port: component.port } : {}),
        ...(target.plan.proxy?.upstream === component.name && target.plan.domain
          ? { route: target.plan.domain }
          : {}),
      },
    })),
  );
  const results = await boundedObservations(
    entries.map(
      ({ target, component, base }) =>
        async (signal): Promise<ComponentReport> => {
          if (component.kind === "installed")
            return {
              ...base,
              state: await effects.artifact(target, component, signal),
            };
          if (component.kind === "persistent")
            return {
              ...base,
              state: (await effects.persistent(target, component, signal))
                ? "ready"
                : "missing",
            };
          const observed = await effects.process(target, component, signal);
          if (observed.state === "stopped") {
            const standing = stoppedStanding(
              target,
              component,
              observed,
              supervisionScope(target),
            );
            const reason = [observed.reason, standing.reason]
              .filter(Boolean)
              .join(" ");
            return {
              ...base,
              ...standing,
              port: component.port,
              ...(reason ? { reason } : {}),
            };
          }
          if (observed.state !== "running")
            return {
              ...base,
              state: observed.state,
              port: component.port,
              ...(observed.reason ? { reason: observed.reason } : {}),
            };
          // A running component can still have something to say, such as output it cannot record or an unknown exit it was
          // started again after.
          const said = [
            observed.reason,
            runningNote(target, component, observed),
          ]
            .filter(Boolean)
            .join(" ");
          const cached =
            component.healthMonitor && health
              ? monitoredHealth(target, component, health)
              : undefined;
          const reason = [said, cached?.reason].filter(Boolean).join(" ");
          return {
            ...base,
            port: component.port,
            pid: observed.pid,
            state: cached
              ? cached.state
              : component.health
                ? (await effects.health(target, component, signal)).ready
                  ? "healthy"
                  : "unhealthy"
                : "running",
            ...(cached ? { health: cached.health } : {}),
            ...(reason ? { reason } : {}),
          };
        },
    ),
    budgetMs,
    deadline,
  );
  let offset = 0;
  return targets.map((target) => {
    const components: ComponentReport[] = target.plan.components.map(() => {
      const base = entries[offset]!.base;
      const result = results[offset++]!;
      if (result.kind === "completed") return result.value;
      return {
        ...base,
        state: "unknown",
        reason:
          result.kind === "expired"
            ? OBSERVATION_EXPIRED
            : "Observation failed.",
      };
    });
    return {
      name: target.name,
      kind: target.kind,
      branch: target.branch,
      commit: target.commit,
      ...deploymentFlags(target),
      route: target.plan.domain,
      components,
      state: aggregate(components),
    };
  });
}
/** How a running Service with health.interval stands by its cached checks: running until one answered, then healthy or
 * unhealthy by the last one, with why and what Rig does about it. */
function monitoredHealth(
  target: Pick<TargetRecord, "id" | "name">,
  component: ManagedComponent,
  results: HealthResults,
): Pick<ComponentReport, "state" | "reason"> & { health: ServiceHealth } {
  const policy = component.healthMonitor!;
  const health: ServiceHealth = results(target, component.name) ?? {
    status: "pending",
    failures: 0,
    threshold: policy.failures,
    restarts: 0,
  };
  if (health.status === "pending")
    return {
      state: "running",
      health,
      reason: "Its ongoing health check has not answered since it started.",
    };
  if (health.status === "healthy") return { state: "healthy", health };
  const failed = `${health.failures} health ${health.failures === 1 ? "check" : "checks"} in a row failed${health.output ? ` (${health.output})` : ""}`;
  const acting = health.failures >= health.threshold;
  return {
    state: "unhealthy",
    health,
    reason: !acting
      ? `${failed}; Rig acts after ${health.threshold}.`
      : health.gaveUp
        ? `${failed}. It stayed unhealthy longer than its health.retry_for, so Rig gave up restarting it and leaves it as it is. Run rig restart ${target.name} once the cause is fixed.`
        : policy.onFailure === "restart"
          ? `${failed}. Rig restarts it${health.restarts ? ` (${health.restarts} health ${health.restarts === 1 ? "restart" : "restarts"} so far)` : ""}.`
          : `${failed}. health.on_failure is report, so Rig reports it and does not restart it.`,
  };
}
/** The reason a component report carries when the shared status deadline expired before its observation finished. */
export const OBSERVATION_EXPIRED =
  "Observation did not complete before the status deadline.";
/** Whether the recorded Commit is a completed deployment; callers such as git push must not treat an incomplete one as deployed. */
export function deploymentFlags(
  target: Pick<
    TargetRecord,
    "deploymentIncomplete" | "recovery" | "destructionPending"
  >,
): Pick<
  TargetReport,
  "deploymentIncomplete" | "transitionPending" | "destructionPending"
> {
  return {
    ...(target.deploymentIncomplete ? { deploymentIncomplete: true } : {}),
    ...(target.recovery ? { transitionPending: true } : {}),
    ...(target.destructionPending ? { destructionPending: true } : {}),
  };
}

/** Managed processes decide whether a Target is live, stopped, starting or
 * failed; the other Components qualify a live Target. Storage or an
 * executable that is missing beside a healthy process is a degraded Target,
 * and a process that runs but fails its check is unhealthy rather than
 * failed. A stopped Target is stopped whatever the state of its data. */
function aggregate(components: ComponentReport[]): TargetReport["state"] {
  if (!components.length) return "configured";
  const managed = components.filter(
    (component) => component.kind === "managed",
  );
  const capabilities = managed.length ? managed : components;
  const others = managed.length
    ? components.filter((component) => component.kind !== "managed")
    : [];
  const usable = (component: ComponentReport) =>
    ["healthy", "running", "installed", "ready"].includes(component.state);
  const present = (component: ComponentReport) =>
    usable(component) || component.state === "unhealthy";
  const qualified = (live: TargetReport["state"]) =>
    others.every(usable) ? live : "degraded";
  if (capabilities.every(usable))
    return qualified(
      managed.length
        ? managed.every((component) => component.state === "healthy")
          ? "healthy"
          : "running"
        : "ready",
    );
  if (capabilities.every(present)) return qualified("unhealthy");
  if (capabilities.some(usable)) return "degraded";
  if (capabilities.every((component) => component.state === "stopped"))
    return "stopped";
  if (capabilities.every((component) => component.state === "starting"))
    return "starting";
  if (
    capabilities.some(
      (component) =>
        component.state === "unknown" || component.state === "starting",
    )
  )
    return "unknown";
  return "failed";
}
