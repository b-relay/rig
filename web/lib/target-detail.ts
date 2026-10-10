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
/** Pure: the paths a Target's hostname serves. A plan with a route map lists it, longest prefix
 * first as recorded; an older plan names only the Service behind `/`, which status marks with the
 * route. Empty without a hostname. */
export function routeLines(
  target: Pick<TargetReport, "route" | "routes" | "components">,
): RouteLine[] {
  if (!target.route) return [];
  const host = target.route.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url = (prefix: string) =>
    `https://${host}${prefix === "/" ? "/" : prefix}`;
  if (target.routes?.length)
    return target.routes.map(({ prefix, service, port }) => ({
      url: url(prefix),
      prefix,
      service,
      port,
    }));
  const upstream = target.components.find(
    (component) => component.route !== undefined,
  );
  return upstream
    ? [
        {
          url: url("/"),
          prefix: "/",
          service: upstream.name,
          ...(upstream.port !== undefined ? { port: upstream.port } : {}),
        },
      ]
    : [];
}
