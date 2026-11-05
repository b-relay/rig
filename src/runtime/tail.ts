import type { ManagedComponent, TargetPlan } from "../config/types";
import { plannedRoutes } from "./ports";

/** Pure: the tail of a stop or start of the Services `acted` (ADR 0020), in plan order: the longest run at the end of that
 * list in which no Service has a path and none depends, directly or transitively, on one that has. A plan with no paths has
 * no tail. `plan` is the full plan, not one a deploy has removed its kept Services from: a kept Service is not in the list,
 * but its paths and its `depends_on` still count. */
export function tailOf(
  plan: Pick<TargetPlan, "domain" | "proxy" | "components" | "serviceDomains">,
  acted: Iterable<string>,
): string[] {
  const routed = new Set(plannedRoutes(plan).map((route) => route.service));
  if (!routed.size) return [];
  const services = plan.components.filter(
    (component): component is ManagedComponent => component.kind === "managed",
  );
  const byName = new Map(services.map((service) => [service.name, service]));
  const reachesPath = (name: string, seen: Set<string>): boolean => {
    if (routed.has(name)) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (byName.get(name)?.dependsOn ?? []).some((dependency) =>
      reachesPath(dependency, seen),
    );
  };
  const names = new Set(acted);
  const list = services
    .map((service) => service.name)
    .filter((name) => names.has(name));
  return list.slice(
    list.findLastIndex((name) => reachesPath(name, new Set())) + 1,
  );
}
