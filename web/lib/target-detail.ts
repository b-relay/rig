import type { ComponentReport, TargetReport } from "./types";

/** Pure: a Service's ports as name and number, named ports first in the order the plan recorded
 * them; a plan without named ports gives its one port without a name. */
export function componentPorts(
  component: Pick<ComponentReport, "port" | "ports">,
): { name?: string; port: number }[] {
  if (component.ports && Object.keys(component.ports).length)
    return Object.entries(component.ports).map(([name, port]) => ({
      name,
      port,
    }));
  return component.port !== undefined ? [{ port: component.port }] : [];
}
/** Pure: the short Commit a Service runs from when a deploy kept it running from an earlier Commit than its Target's
 * (ADR 0016), such as `1a2b3c4`; nothing for one that runs the Target's own Commit, or whose Commit is not known. */
export function keptFrom(
  target: Pick<TargetReport, "commit">,
  component: Pick<ComponentReport, "commit">,
): string | undefined {
  return component.commit && target.commit && component.commit !== target.commit
    ? component.commit.slice(0, 7)
    : undefined;
}
/** Pure: how a stopped Service ended, in a few words; nothing for one that runs or never ran. */
export function exitText(
  component: Pick<ComponentReport, "exit" | "exitCode" | "signal">,
): string | undefined {
  if (!component.exit) return undefined;
  const how =
    component.signal !== undefined
      ? `signal ${component.signal}`
      : component.exitCode !== undefined
        ? `code ${component.exitCode}`
        : undefined;
  const word = {
    clean: "Exited cleanly",
    failed: "Exited with a failure",
    requested: "Stopped on request",
    unknown: "Gone, with nothing recording how",
  }[component.exit];
  return how ? `${word} (${how}).` : `${word}.`;
}
/** One path under a Target's hostname and where it leads. */
export interface RouteLine {
  /** The URL a browser opens, with Caddy's scheme. */
  url: string;
  prefix: string;
  service: string;
  port?: number;
}
/** The URL a browser opens for one path of a hostname. */
function routeUrl(hostname: string, prefix: string): string {
  const host = hostname.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}${prefix === "/" ? "/" : prefix}`;
}
/** Pure: the paths every hostname of a Target serves: its domain's first, then each Service domain's
 * one path. A plan with a route map lists it, longest prefix first as recorded; an older plan names
 * only the Service behind `/`, which status marks with the route. Empty without a hostname. */
export function routeLines(
  target: Pick<
    TargetReport,
    "route" | "routes" | "serviceDomains" | "components"
  >,
): RouteLine[] {
  return [
    ...domainLines(target),
    ...(target.serviceDomains ?? []).map(({ hostname, service, port }) => ({
      url: routeUrl(hostname, "/"),
      prefix: "/",
      service,
      port,
    })),
  ];
}
function domainLines(
  target: Pick<TargetReport, "route" | "routes" | "components">,
): RouteLine[] {
  const domain = target.route;
  if (!domain) return [];
  if (target.routes?.length)
    return target.routes.map(({ prefix, service, port }) => ({
      url: routeUrl(domain, prefix),
      prefix,
      service,
      port,
    }));
  const upstream = target.components.find(
    (component) => component.route === domain,
  );
  return upstream
    ? [
        {
          url: routeUrl(domain, "/"),
          prefix: "/",
          service: upstream.name,
          ...(upstream.port !== undefined ? { port: upstream.port } : {}),
        },
      ]
    : [];
}
