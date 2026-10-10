import { readFile, readlink } from "node:fs/promises";
import type { ProxySettings } from "../config/proxy-schema";
import {
  caddyfileSites,
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
      readonly source: "custom";
      readonly certificate?: string;
    };
/** What `rig proxy` shows: the job, every served site and whether the custom files are applied. */
export interface ProxyReport {
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
  readonly custom: readonly {
    readonly file: string;
    readonly state: "applied" | "pending";
  }[];
}
/** A Target as the report names it. */
export interface ReportedTarget {
  readonly id: string;
  readonly project: string;
  readonly name: string;
}
/** Builds the report from the current generation, which is what Caddy was given, never from plans. */
export async function proxyReport(options: {
  readonly root: string;
  readonly settings: ProxySettings;
  readonly job: CaddyJob;
  readonly admin: CaddyAdmin;
  readonly targets: readonly ReportedTarget[];
}): Promise<ProxyReport> {
  const paths = proxyPaths(options.root);
  const generation = await readlink(paths.current).catch(() => undefined);
  const files = generationFiles(paths.current);
  const read = (path: string) => readFile(path, "utf8").catch(() => "");
  const [routes, custom, customGlobal, diskCustom, diskGlobal] =
    await Promise.all([
      read(files.routes),
      read(files.custom),
      read(files.customGlobal),
      read(paths.custom),
      read(paths.customGlobal),
    ]);
  const [reachable, state] = await Promise.all([
    options.admin.reachable(),
    options.job.state(),
  ]);
  const customSites = caddyfileSites(custom);
  const parents =
    options.settings.tls.certificates === "wildcard"
      ? new Set(wildcardParents(routeFileHostnames(routes)))
      : new Set<string>();
  for (const site of customSites) parents.add(site.toLowerCase());
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
  for (const hostname of customSites.filter((site) => !site.includes("*")))
    sites.push({ hostname, source: "custom", ...certificate(hostname) });
  const binary = await installedBinary(paths);
  return {
    caddy: {
      state: reachable
        ? "running"
        : state === "stopped"
          ? "stopped"
          : "unreachable",
      ...(binary ? { binary } : {}),
      ports: options.settings.ports,
      ca: options.settings.tls.ca,
      ...(generation ? { generation: generation.split("/").at(-1)! } : {}),
    },
    sites: sites.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    custom: [
      {
        file: paths.custom,
        state: diskCustom === custom ? "applied" : "pending",
      },
      {
        file: paths.customGlobal,
        state: diskGlobal === customGlobal ? "applied" : "pending",
      },
    ],
  };
}
