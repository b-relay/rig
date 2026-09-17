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
import { stoppedStanding } from "./supervision";
import type { HealthCheck, ProcessObservation } from "../providers/contracts";
export interface ObservationEffects {
  process(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<ProcessObservation>;
  health(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
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
}
/** Read-only observations share one deadline; unresponsive adapters cannot extend the request budget.
 * The caller chooses the budget and the deadline scheduler, so a test can expire an observation deterministically. */
export async function observeTargets(
  targets: readonly TargetRecord[],
  effects: ObservationEffects,
  budgetMs: number,
  deadline: ObservationDeadline,
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
            const standing = stoppedStanding(target, component, observed);
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
          return {
            ...base,
            port: component.port,
            pid: observed.pid,
            state: component.health
              ? (await effects.health(target, component, signal)).ready
                ? "healthy"
                : "unhealthy"
              : "running",
            // A running component can still have something to say, such as output it cannot record.
            ...(observed.reason ? { reason: observed.reason } : {}),
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
