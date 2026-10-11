import type { ProxyReport } from "../../src/adapters/proxy-report";
import type { ProjectEntry } from "./overview";
import type { Outcome } from "./outcome";
import { orderedTargets } from "./overview";
import { routeLines } from "./target-detail";
import type { TargetReport } from "./types";

/* The Proxy page reads through this module. With Rig's own Caddy (ADR 0014), rigd's proxy read is the
 * authority on every hostname served: each Target's paths and the owner's own routes from proxy.routes
 * in Host config; each Target's status adds the Service and state. Without it, the Host's Caddy serves
 * Rig's route file and every hostname comes from status alone. proxy.routes is read-only here: it is
 * edited in config.yaml and applied with rig proxy reload. */

/** One hostname and path Caddy serves, and what it reaches. */
export interface ProxyRoute {
  /** The hostname, with a port when it is not the scheme's default. */
  host: string;
  /** The URL a browser opens. */
  url: string;
  prefix: string;
  /** A Target's route, or one of the owner's own routes from proxy.routes. */
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
/** Pure: the bare hostname of a site address as Caddy matches it: no scheme, no port, lowercase. */
export function bareHostname(address: string): string {
  return address
    .replace(/^https?:\/\//i, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}
/** Pure: the URL of `prefix` on a site address, which may carry a scheme and a port. Without a port it is
 * the one Caddy serves that scheme on, written only when it is not the scheme's default. */
export function siteUrl(
  address: string,
  ports: { http: number; https: number },
  prefix = "/",
): string {
  const scheme = /^http:\/\//i.test(address) ? "http" : "https";
  const explicit = /:(\d+)$/.exec(address.replace(/^https?:\/\//i, ""))?.[1];
  const port = explicit ? Number(explicit) : ports[scheme];
  const standard = scheme === "https" ? 443 : 80;
  return `${scheme}://${bareHostname(address)}${port === standard ? "" : `:${port}`}${prefix}`;
}
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
/** Pure: what Rig's own Caddy reports it serves, every Target path and every one of the owner's routes, with
 * the Service and state the Targets' status adds where it names the same hostname and path. Hostnames are
 * compared bare and lowercase, and links carry the HTTPS port Caddy serves on when it is not 443. */
export function managedProxyRoutes(
  report: ProxyReport,
  fromStatus: readonly ProxyRoute[],
): ProxyRoute[] {
  const ports = report.caddy.ports;
  return report.sites
    .flatMap((site): ProxyRoute[] => {
      if (site.source === "custom") {
        const url = siteUrl(site.hostname, ports);
        return [
          {
            host: new URL(url).host,
            url,
            prefix: "/",
            source: "custom",
            upstream: site.upstream,
            published: true,
          },
        ];
      }
      return site.routes.map((path): ProxyRoute => {
        const known = fromStatus.find(
          (route) =>
            bareHostname(new URL(route.url).host) ===
              bareHostname(site.hostname) &&
            route.prefix === path.prefix &&
            route.project === site.project &&
            route.target === site.target,
        );
        const url = siteUrl(site.hostname, ports, path.prefix);
        return {
          host: new URL(url).host,
          url,
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
/** Pure: how the owner's own routes are set, or why this Host has none: they need Rig's own Caddy. */
export function ownRoutesNote(read: Outcome<ProxyReport>): string {
  if (read.ok)
    return "Set them under proxy.routes in config.yaml, as hostname: port (or 127.0.0.1:<port>), and run rig proxy reload to apply them.";
  return read.failure.code === "PROXY_UNMANAGED"
    ? "The Host's Caddy serves Rig's routes. With a proxy section in config.yaml, Rig runs its own Caddy (ADR 0014) and your own hostnames go under proxy.routes."
    : `rigd could not report its Caddy: ${read.failure.message}`;
}
/** Pure: Host config's proxy settings that Caddy does not serve, and why, for a notice beside what it does serve; undefined
 * when it serves them, or without Rig's own Caddy. */
export function pendingNote(read: Outcome<ProxyReport>): string | undefined {
  if (!read.ok || !read.value.pending) return undefined;
  const { fields, reason } = read.value.pending;
  return `The proxy settings in config.yaml${fields.length ? ` (${fields.join(", ")})` : ""} are not served yet, so this page shows what Caddy last accepted. ${reason}`;
}
