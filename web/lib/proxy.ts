import type { ProxyReport } from "../../src/adapters/proxy-report";
import type { ProjectEntry } from "./board-rows";
import type { Outcome } from "./outcome";
import { orderedTargets } from "./overview";
import { routeLines } from "./target-detail";
import type { TargetReport } from "./types";

/* The Proxy page reads through this module. With Rig's own Caddy (ADR 0014), rigd's proxy read is the
 * authority on every hostname served, its upstream, and the custom file the operator owns beside Rig's
 * routes; each Target's status adds the Service and state. Without it, the Host's Caddy serves Rig's
 * route file and every hostname comes from status alone. The custom file is shown read-only: it is
 * edited on disk and applied with rig proxy reload. */

/** One hostname and path Caddy serves, and what it reaches. */
export interface ProxyRoute {
  host: string;
  /** The URL a browser opens. */
  url: string;
  prefix: string;
  /** A Target's route, or a site in the operator's custom Caddy file. */
  source: "target" | "custom";
  project?: string;
  target?: string;
  kind?: TargetReport["kind"];
  service?: string;
  /** `127.0.0.1:<port>`, when the port is known. */
  upstream?: string;
  /** Caddy answers 503 here: Rig withdrew the path's upstream (it is stopped or being replaced). */
  withheld?: boolean;
  /** The Target's state, so a route to a stopped Target reads as such. */
  state?: string;
  /** False when the Host's Caddy does not load Rig's route file, so the route is inert. */
  published: boolean;
}
const byHostThenPrefix = (a: ProxyRoute, b: ProxyRoute) =>
  a.host.localeCompare(b.host) || b.prefix.length - a.prefix.length;
/** Pure: every route on the Host from each Project's status, by host and then longest prefix first. */
export function proxyRoutes(entries: readonly ProjectEntry[]): ProxyRoute[] {
  return entries
    .flatMap(({ project, status }) =>
      status?.ok
        ? orderedTargets(status.value.targets).flatMap((target) =>
            routeLines(target).map((line): ProxyRoute => ({
              host: new URL(line.url).host,
              url: line.url,
              prefix: line.prefix,
              source: "target",
              project: project.name,
              target: target.name,
              kind: target.kind,
              service: line.service,
              ...(line.port !== undefined
                ? { upstream: `127.0.0.1:${line.port}` }
                : {}),
              state: target.state,
              published: target.routePublished !== false,
            })),
          )
        : [],
    )
    .sort(byHostThenPrefix);
}
/** Pure: what Rig's own Caddy reports it serves, every Target path and custom site, with the Service and
 * state the Targets' status adds where it names the same hostname and path. */
export function managedProxyRoutes(
  report: ProxyReport,
  fromStatus: readonly ProxyRoute[],
): ProxyRoute[] {
  return report.sites
    .flatMap((site): ProxyRoute[] => {
      if (site.source === "custom")
        return [
          {
            host: site.hostname,
            url: `https://${site.hostname}/`,
            prefix: "/",
            source: "custom",
            published: true,
          },
        ];
      return site.routes.map((path): ProxyRoute => {
        const known = fromStatus.find(
          (route) =>
            new URL(route.url).hostname === site.hostname &&
            route.prefix === path.prefix &&
            route.project === site.project &&
            route.target === site.target,
        );
        return {
          host: known?.host ?? site.hostname,
          url: known?.url ?? `https://${site.hostname}${path.prefix}`,
          prefix: path.prefix,
          source: "target",
          project: site.project,
          target: site.target,
          ...(known?.kind ? { kind: known.kind } : {}),
          ...(known?.service ? { service: known.service } : {}),
          ...(known?.state ? { state: known.state } : {}),
          ...(path.upstream === null
            ? { withheld: true }
            : { upstream: path.upstream }),
          published: true,
        };
      });
    })
    .sort(byHostThenPrefix);
}
/** What the Proxy page can say about the custom Caddy file. */
export type CustomCaddy =
  | { supported: false; reason: string }
  | {
      supported: true;
      path: string;
      /** Pending: changed on disk since rig proxy reload last applied it. */
      state: "applied" | "pending";
      text: string;
    };
/** Pure: the custom Caddy file from rigd's proxy read, or why there is none. */
export function customCaddyFile(read: Outcome<ProxyReport>): CustomCaddy {
  if (!read.ok)
    return {
      supported: false,
      reason:
        read.failure.code === "PROXY_UNMANAGED"
          ? "The Host's Caddy serves Rig's routes, so there is no custom file here. With a proxy section in config.yaml, Rig runs its own Caddy (ADR 0014) and the Caddy file you own beside its routes shows here."
          : `rigd could not report its Caddy: ${read.failure.message}`,
    };
  const file = read.value.custom[0];
  if (!file)
    return { supported: false, reason: "rigd reported no custom file." };
  return {
    supported: true,
    path: file.file,
    state: file.state,
    text: file.text ?? "",
  };
}
