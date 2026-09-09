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
): Promise<TargetReport[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const withinDeadline = async <T>(
    work: Promise<T>,
    fallback: T,
  ): Promise<T> => {
    if (controller.signal.aborted) return fallback;
    return await new Promise<T>((resolve) => {
      const abort = () => {
        controller.signal.removeEventListener("abort", abort);
        resolve(fallback);
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      work
        .then(resolve, () => resolve(fallback))
        .finally(() => controller.signal.removeEventListener("abort", abort));
    });
  };
  try {
    return await Promise.all(
      targets.map(async (target) => {
        const components = await Promise.all(
          target.plan.components.map((component) => {
            const base = {
              name: component.name,
              kind: component.kind,
              ...(component.kind === "managed" ? { port: component.port } : {}),
              ...(target.plan.proxy?.upstream === component.name &&
              target.plan.domain
                ? { route: target.plan.domain }
                : {}),
            };
            return withinDeadline(
              (async (): Promise<ComponentReport> => {
                if (component.kind === "installed")
                  return {
                    ...base,
                    state: await effects.artifact(
                      target,
                      component,
                      controller.signal,
                    ),
                  };
                if (component.kind === "persistent")
                  return {
                    ...base,
                    state: (await effects.persistent(
                      target,
                      component,
                      controller.signal,
                    ))
                      ? "ready"
                      : "missing",
                  };
                const observed = await effects.process(
                  target,
                  component,
                  controller.signal,
                );
                if (observed.state !== "running")
                  return {
                    ...base,
                    state: observed.restartPending
                      ? "starting"
                      : observed.state === "stopped" &&
                          target.desired === "running"
                        ? "failed"
                        : observed.state,
                    port: component.port,
                    ...(observed.exitCode === undefined
                      ? {}
                      : { exitCode: observed.exitCode }),
                    ...(observed.reason
                      ? { reason: observed.reason }
                      : observed.state === "stopped" &&
                          target.desired === "running"
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
                    ? (await effects.health(
                        target,
                        component,
                        controller.signal,
                      ))
                      ? "healthy"
                      : "unhealthy"
                    : "running",
                };
              })(),
              {
                ...base,
                state: "unknown",
                reason:
                  "Observation did not complete before the status deadline.",
              },
            );
          }),
        );
        return {
          name: target.name,
          kind: target.kind,
          branch: target.branch,
          commit: target.commit,
          route: target.plan.domain,
          components,
          state: aggregate(components),
        };
      }),
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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
