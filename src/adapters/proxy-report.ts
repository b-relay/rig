import { readFile, readlink } from "node:fs/promises";
import {
  acceptedProxySettings,
  currentCustomRoutes,
  pendingSettings,
  type PendingSettings,
} from "./proxy-generation";
import type { ProxySettings } from "../config/proxy-schema";
import {
  certificateName,
  generationFiles,
  proxyPaths,
  wildcardParents,
} from "../domain/managed-proxy";
import type { CaddyAdmin, CaddyJob } from "../providers/managed-caddy";
import { installedBinary } from "../providers/caddy-binary";
import {
  ownedBlock,
  parseOwnedSites,
  routeFileHostnames,
  type RoutePath,
} from "../providers/route-file";

/** One hostname Rig's Caddy serves. */
export type ProxySite =
  | {
      readonly hostname: string;
      readonly source: "target";
      readonly project: string;
      readonly target: string;
      readonly routes: readonly RoutePath[];
      /** The certificate subject that covers it; absent for plain HTTP. */
      readonly certificate?: string;
    }
  | {
      readonly hostname: string;
      /** One of the owner's own routes, from proxy.routes in Host config. */
      readonly source: "custom";
      /** The loopback address it reaches. */
      readonly upstream: string;
      readonly certificate?: string;
    };
/** What `rig proxy` shows: the job and every served site, Rig's Targets' and the owner's own routes, all as the current
 * generation serves them, and Host config's proxy settings that are not served yet. */
export interface ProxyReport {
  /** The job, and the ports and CA of the settings Caddy accepted. */
  readonly caddy: {
    /** running answers on its socket; unreachable runs (or may) but does not answer; stopped is confirmed. */
    readonly state: "running" | "unreachable" | "stopped";
    readonly binary?: string;
    readonly ports: { readonly http: number; readonly https: number };
    readonly ca: string;
    /** The current generation's id, or absent before the first. */
    readonly generation?: string;
  };
  readonly sites: readonly ProxySite[];
  /** Host config's proxy settings that Caddy does not serve: refused, with why, or not applied yet. */
  readonly pending?: PendingSettings;
}
/** A Target as the report names it. */
export interface ReportedTarget {
  readonly id: string;
  readonly project: string;
  readonly name: string;
}
/** Builds the report from the current generation, which is what Caddy was given, never from plans or from Host config;
 * Host config (`requested`) only decides what is pending. */
export async function proxyReport(options: {
  readonly root: string;
  /** The proxy section of Host config now, or why it cannot be read. */
  readonly requested: ProxySettings | Error;
  readonly job: CaddyJob;
  readonly admin: CaddyAdmin;
  readonly targets: readonly ReportedTarget[];
}): Promise<ProxyReport> {
  const paths = proxyPaths(options.root);
  const generation = await readlink(paths.current).catch(() => undefined);
  const files = generationFiles(paths.current);
  const read = (path: string) => readFile(path, "utf8").catch(() => "");
  const routes = await read(files.routes);
  const [reachable, state] = await Promise.all([
    options.admin.reachable(),
    options.job.state(),
  ]);
  const customRoutes = await currentCustomRoutes(options.root);
  // Before the first generation nothing is served; Host config is what the first one will be.
  const served =
    (await acceptedProxySettings(options.root)) ??
    (options.requested instanceof Error ? undefined : options.requested);
  const pending = await pendingSettings(options.root, options.requested);
  const parents =
    served?.tls.certificates === "wildcard"
      ? new Set(
          wildcardParents([
            ...routeFileHostnames(routes),
            ...customRoutes.map((route) => route.hostname),
          ]),
        )
      : new Set<string>();
  const certificate = (hostname: string) => {
    const name = certificateName(hostname);
    if (!name) return {};
    const parent = `*.${name.split(".").slice(1).join(".")}`;
    return { certificate: parents.has(parent) ? parent : name };
  };
  const sites: ProxySite[] = [];
  for (const target of options.targets) {
    const block = ownedBlock(routes, target.id);
    if (!block) continue;
    for (const site of parseOwnedSites(block))
      sites.push({
        hostname: site.hostname,
        source: "target",
        project: target.project,
        target: target.name,
        routes: site.routes,
        ...certificate(site.hostname),
      });
  }
  for (const route of customRoutes)
    sites.push({
      hostname: route.hostname,
      source: "custom",
      upstream: route.upstream,
      ...certificate(route.hostname),
    });
  const binary = await installedBinary(paths);
  return {
    caddy: {
      state: reachable
        ? "running"
        : state === "stopped"
          ? "stopped"
          : "unreachable",
      ...(binary ? { binary } : {}),
      ports: served?.ports ?? { http: 80, https: 443 },
      ca: served?.tls.ca ?? "unknown",
      ...(generation ? { generation: generation.split("/").at(-1)! } : {}),
    },
    sites: sites.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    ...(pending ? { pending } : {}),
  };
}
