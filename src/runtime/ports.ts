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
/** Every port other Targets own, with its owner: their recorded plan and, while a deployment transition is unresolved, the plan that recovery may restore. */
export function portOwners(
  targets: readonly Pick<TargetRecord, "id" | "name" | "plan" | "recovery">[],
  except: string,
): Map<number, { target: string; project: string }> {
  return new Map(
    targets
      .filter((target) => target.id !== except)
      .flatMap((target) =>
        [
          ...Object.values(recordedPorts(target.plan.components)),
          ...(target.recovery
            ? Object.values(recordedPorts(target.recovery.plan.components))
            : []),
        ].map((port): [number, { target: string; project: string }] => [
          port,
          { target: target.name, project: target.plan.project },
        ]),
      ),
  );
}
