import type { JobReport, TargetReport } from "../domain/project-status";
import type { ProjectConfig } from "../config/types";
import { roleHostname, roleServiceDomains } from "../config/hostnames";
import {
  DEFAULT_JOB_TARGETS,
  defaultProxy,
  durationSeconds,
  patchedSettings,
  proxyUpstream,
  rolePatch,
} from "../config/schema";
import { hostnameFields, type ComponentReport } from "./status";
import { unrecordedRefusals } from "./target-refusals";

/** What rig.yaml gives a working or stable Target nothing has recorded: its Services and Tools, every hostname it would
 * serve, and its jobs. */
export interface ConfiguredTarget {
  components: ComponentReport[];
  hostnames: string[];
  jobs: JobReport[];
}

/** The hostnames rig.yaml routes for a role, by the same per-role rules planning uses: the role's domain and the Service its
 * '/' reaches, if any, and every Service's own hostnames. */
export interface ConfiguredRoutes {
  domain?: string;
  /** The Service the domain's '/' reaches; absent when it reaches none or a port only. */
  upstream?: string;
  own: { service: string; hostname: string }[];
}

type Settings = ReturnType<typeof patchedSettings>;

/** Pure: what rig.yaml gives `role` before anything is recorded of it. */
export function configuredTarget(
  config: ProjectConfig,
  role: "working" | "stable",
  clock: { timeZone(): string },
): ConfiguredTarget {
  const settings = patchedSettings(config, role);
  const routes = configuredRoutes(config, role, settings);
  return {
    components: configuredComponents(settings, routes),
    hostnames: configuredHostnames(routes),
    jobs: configuredJobs(settings, role, clock),
  };
}

/** Pure: the report of a working or stable Target rig.yaml turns on and nothing has recorded: configured, refusing what
 * needs it to exist. */
export function unrecordedReport(
  role: "working" | "stable",
  configured: ConfiguredTarget,
  project: string,
): TargetReport {
  return {
    name: role,
    kind: role,
    state: "configured",
    ...(configured.hostnames.length ? { hostnames: configured.hostnames } : {}),
    refusals: unrecordedRefusals(role, project),
    components: configured.components,
    ...(configured.jobs.length ? { jobs: configured.jobs } : {}),
  };
}

/** Pure: where rig.yaml routes `role`'s hostnames, `${rig.target}` replaced by the role. */
export function configuredRoutes(
  config: ProjectConfig,
  role: "working" | "stable",
  settings: Settings,
): ConfiguredRoutes {
  const named = (pattern: string) => pattern.replaceAll("${rig.target}", role);
  const routed = roleHostname(
    config.domain,
    rolePatch(config, role).domain,
    role,
  );
  const domain = routed && named(routed.pattern);
  const proxy =
    settings.proxy ??
    (domain !== undefined ? defaultProxy(settings.services) : undefined);
  const root = proxy?.["/"]
    ? proxyUpstream(proxy["/"], settings.services ?? {})
    : undefined;
  const upstream = root && "service" in root ? root.service : undefined;
  const own = roleServiceDomains(
    config.services,
    rolePatch(config, role).services,
    settings.services,
    role,
  ).map((entry) => ({
    service: entry.service,
    hostname: named(entry.pattern),
  }));
  return {
    ...(domain !== undefined ? { domain } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
    own,
  };
}

/** Pure: every hostname the Target would serve: its domain while '/' reaches a Service, then each Service's own. */
export function configuredHostnames(routes: ConfiguredRoutes): string[] {
  return [
    ...new Set([
      ...(routes.domain && routes.upstream ? [routes.domain] : []),
      ...routes.own.map((entry) => entry.hostname),
    ]),
  ];
}

/** Pure: the hostnames that reach `service`. Two settings that meet only once ${rig.target} is replaced are refused when
 * the Target is planned; until then each hostname is listed once. */
export function serviceRoutes(
  routes: ConfiguredRoutes,
  service: string,
): string[] {
  return [
    ...new Set([
      ...(routes.upstream === service && routes.domain ? [routes.domain] : []),
      ...routes.own
        .filter((entry) => entry.service === service)
        .map((entry) => entry.hostname),
    ]),
  ];
}

/** Pure: the role's Services, each with its first port and the hostnames that reach it, then its Tools, all configured. */
export function configuredComponents(
  settings: Settings,
  routes: ConfiguredRoutes,
): ComponentReport[] {
  return [
    ...Object.entries(settings.services ?? {}).map(
      ([name, service]): ComponentReport => {
        const port = Object.values(service.ports ?? {})[0];
        return {
          name,
          kind: "managed",
          state: "configured",
          ...(typeof port === "number" ? { port } : {}),
          ...hostnameFields(serviceRoutes(routes, name)),
        };
      },
    ),
    ...Object.keys(settings.tools ?? {}).map((name): ComponentReport => ({
      name,
      kind: "installed",
      state: "configured",
    })),
  ];
}

/** Pure: the role's jobs, in name order. Every role plans every job; none is scheduled until the Target exists, and then
 * only where its targets name the role. A Target nothing has recorded has no runs, and rig run refuses it until it exists. */
export function configuredJobs(
  settings: Settings,
  role: "working" | "stable",
  clock: { timeZone(): string },
): JobReport[] {
  const [made, command] =
    role === "working" ? ["up", "rig up"] : ["deployed", "rig deploy"];
  return Object.entries(settings.jobs ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, job]): JobReport => ({
      name,
      schedule: job.schedule,
      timeZone: job.timezone ?? clock.timeZone(),
      state: "idle",
      scheduled: false,
      ...(job.timeout !== undefined
        ? { timeout: durationSeconds(job.timeout) }
        : {}),
      reason: (job.targets ?? DEFAULT_JOB_TARGETS).includes(role)
        ? `${role} is not ${made} yet, so its jobs are not scheduled; ${command} schedules them.`
        : `jobs.${name}.targets does not name ${role}, so its schedule never runs it here; once ${role} is ${made}, rig run runs it.`,
      ...(job.backup
        ? {
            backup: {
              keep: job.backup.keep,
              restore: job.backup.restore !== undefined,
              count: 0,
              bytes: 0,
            },
          }
        : {}),
    }));
}
