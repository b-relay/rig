import type {
  ManagedComponent,
  PlanComponent,
  PlanRoute,
  TargetPlan,
} from "../config/types";
import type { TargetRecord } from "../domain/runtime";

/** Every port a Service declares, by name. A plan recorded before named ports names its one port `port`. */
export function declaredPorts(
  component: Pick<ManagedComponent, "port" | "ports">,
): Record<string, number> {
  return (
    component.ports ??
    (component.port === undefined ? {} : { port: component.port })
  );
}
/** The Target's route map, longest prefix first; empty without a hostname or a proxy. A plan recorded before route maps
 * routes '/' to its upstream's one port. */
export function plannedRoutes(
  plan: Pick<TargetPlan, "domain" | "proxy" | "components">,
): PlanRoute[] {
  if (!plan.domain || !plan.proxy) return [];
  if (plan.proxy.routes) return plan.proxy.routes;
  const upstream = plan.components.find(
    (component) => component.name === plan.proxy!.upstream,
  );
  return upstream?.kind === "managed" && upstream.port !== undefined
    ? [{ prefix: "/", service: upstream.name, port: upstream.port }]
    : [];
}
/** Recorded assignments keyed `<service>.<port>`, as `resolveTargetPlan` takes them back; a plan recorded before named
 * ports yields its Service name alone. Includes the separate Convex site port. */
export function recordedPorts(
  components: readonly PlanComponent[],
): Record<string, number> {
  return Object.fromEntries(
    components.flatMap((component) =>
      component.kind === "managed"
        ? [
            ...(component.ports
              ? Object.entries(component.ports).map(([port, value]) => [
                  `${component.name}.${port}`,
                  value,
                ])
              : component.port === undefined
                ? []
                : [[component.name, component.port]]),
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
