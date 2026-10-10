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
/** One hostname a Target serves and its route map, longest prefix first. */
export interface PlanSite {
  hostname: string;
  routes: PlanRoute[];
}
/** Every hostname the Target serves, each with its route map: its `domain` with the proxy's map first, when it has both,
 * then each Service domain, which routes '/' to its Service's port. Empty when it serves none. A site whose map is empty
 * names no managed upstream, which publishing refuses. A plan recorded before route maps routes '/' to its upstream's one
 * port. */
export function plannedSites(
  plan: Pick<TargetPlan, "domain" | "proxy" | "components" | "serviceDomains">,
): PlanSite[] {
  return [
    ...domainSite(plan),
    ...(plan.serviceDomains ?? []).map(({ hostname, service, port }) => ({
      hostname,
      routes: [{ prefix: "/", service, port }],
    })),
  ];
}
function domainSite(
  plan: Pick<TargetPlan, "domain" | "proxy" | "components">,
): PlanSite[] {
  if (!plan.domain || !plan.proxy) return [];
  if (plan.proxy.routes)
    return [{ hostname: plan.domain, routes: plan.proxy.routes }];
  const upstream = plan.components.find(
    (component) => component.name === plan.proxy!.upstream,
  );
  return [
    {
      hostname: plan.domain,
      routes:
        upstream?.kind === "managed" && upstream.port !== undefined
          ? [{ prefix: "/", service: upstream.name, port: upstream.port }]
          : [],
    },
  ];
}
/** Every route of every site the Target serves; a Service routed under several hostnames appears once per route. */
export function plannedRoutes(
  plan: Pick<TargetPlan, "domain" | "proxy" | "components" | "serviceDomains">,
): PlanRoute[] {
  return plannedSites(plan).flatMap((site) => site.routes);
}
/** The hostnames whose '/' reaches `service`, in site order: the Target's domain when the Service is its '/' upstream, then
 * the Service's own domains. */
export function serviceHostnames(
  plan: Pick<TargetPlan, "domain" | "proxy" | "serviceDomains">,
  service: string,
): string[] {
  return [
    ...(plan.domain && plan.proxy?.upstream === service ? [plan.domain] : []),
    ...(plan.serviceDomains ?? [])
      .filter((entry) => entry.service === service)
      .map((entry) => entry.hostname),
  ];
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
