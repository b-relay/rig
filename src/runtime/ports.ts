import type { PlanComponent } from "../config/types";

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
