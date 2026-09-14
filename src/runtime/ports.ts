import type { PlanComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";

/** Reuses recorded assignments, including the separate Convex site port. */
export function recordedPorts(
  components: readonly PlanComponent[],
): Record<string, number> {
  return Object.fromEntries(
    components.flatMap((component) =>
      component.kind === "managed"
        ? [
            [component.name, component.port],
            ...(component.sitePort
              ? [[`${component.name}.site`, component.sitePort]]
              : []),
          ]
        : [],
    ),
  );
}
/** Every port other Targets own: their recorded plan and, while a deployment transition is unresolved, the plan that recovery may restore. */
export function occupiedPorts(
  targets: readonly Pick<TargetRecord, "id" | "plan" | "recovery">[],
  except: string,
): Set<number> {
  return new Set(
    targets
      .filter((target) => target.id !== except)
      .flatMap((target) => [
        ...Object.values(recordedPorts(target.plan.components)),
        ...(target.recovery
          ? Object.values(recordedPorts(target.recovery.plan.components))
          : []),
      ]),
  );
}
