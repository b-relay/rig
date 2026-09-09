import {
  boundedObservations,
  timerObservationDeadline,
  type ObservationDeadline,
} from "./bounded-observations";
import type {
  InstalledComponent,
  ManagedComponent,
  PersistentComponent,
} from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type { ProcessObservation } from "../providers/contracts";
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
  ): Promise<boolean>;
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
export interface ComponentReport {
  name: string;
  kind: "managed" | "installed" | "persistent";
  state: string;
  pid?: number;
  port?: number;
  route?: string;
  exitCode?: number;
  reason?: string;
}
export interface TargetReport {
  name: string;
  kind: string;
  state: string;
  branch?: string;
  commit?: string;
  route?: string;
  components: ComponentReport[];
}
/** Read-only observations share one deadline; unresponsive adapters cannot extend the request budget. */
export async function observeTargets(
  targets: readonly TargetRecord[],
  effects: ObservationEffects,
  budgetMs = 2000,
  deadline: ObservationDeadline = timerObservationDeadline,
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
          if (observed.state !== "running")
            return {
              ...base,
              state: observed.restartPending
                ? "starting"
                : observed.state === "stopped" && target.desired === "running"
                  ? "failed"
                  : observed.state,
              port: component.port,
              ...(observed.exitCode === undefined
                ? {}
                : { exitCode: observed.exitCode }),
              ...(observed.reason
                ? { reason: observed.reason }
                : observed.state === "stopped" && target.desired === "running"
                  ? {
                      reason:
                        observed.exitCode === undefined
                          ? "The expected process is not running."
                          : `The process exited with code ${observed.exitCode}.`,
                    }
                  : {}),
            };
          return {
            ...base,
            port: component.port,
            pid: observed.pid,
            state: component.health
              ? (await effects.health(target, component, signal))
                ? "healthy"
                : "unhealthy"
              : "running",
          };
        },
    ),
    budgetMs,
    deadline,
  );
  let offset = 0;
  return targets.map((target) => {
    const components = target.plan.components.map(() => {
      const base = entries[offset]!.base;
      const result = results[offset++]!;
      if (result.kind === "completed") return result.value;
      return {
        ...base,
        state: "unknown",
        reason:
          result.kind === "expired"
            ? "Observation did not complete before the status deadline."
            : "Observation failed.",
      };
    });
    return {
      name: target.name,
      kind: target.kind,
      branch: target.branch,
      commit: target.commit,
      route: target.plan.domain,
      components,
      state: aggregate(components),
    };
  });
}

function aggregate(components: ComponentReport[]): string {
  if (!components.length) return "configured";
  const managed = components.filter(
    (component) => component.kind === "managed",
  );
  const capabilities = managed.length ? managed : components;
  const usable = (component: ComponentReport) =>
    ["healthy", "running", "installed", "ready"].includes(component.state);
  if (capabilities.every(usable))
    return managed.length
      ? managed.every((component) => component.state === "healthy")
        ? "healthy"
        : "running"
      : "ready";
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
