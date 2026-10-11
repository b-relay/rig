import { isAbsolute, join, relative, resolve } from "node:path";
import { ConfigError } from "./errors";
import { DEFAULT_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
import { DEFAULT_RESTART_POLICY } from "./plan-defaults";
import {
  DEFAULT_JOB_TARGETS,
  durationSeconds,
  parseProjectConfig,
  patchedSettings,
  proxyUpstream,
  defaultProxy,
  rolePatch,
  localhostCommand,
  localhostHealth,
  validHostname,
} from "./schema";
import {
  HEALTHCHECK_DEFAULTS,
  execCommand,
  healthcheckInForce,
  healthcheckTest,
  isHealthUrl,
  type HealthcheckSettings,
} from "./healthcheck";
import {
  referenceResolver,
  type PublicInput,
  type ResolvedText,
} from "./references";
import { planWorkingDir } from "./working-dir";
import {
  roleHostname,
  roleServiceDomains,
  serviceDomainPort,
  type RoleHostname,
} from "./hostnames";
import type {
  BuildUnit,
  EnvFileRef,
  ManagedComponent,
  PlanRoute,
  PlanServiceDomain,
  ProjectConfig,
  PlanComponent,
  PlanJob,
  ResolveHost,
  ResolveTargetPlanInput,
  TargetPlan,
} from "./types";
type Service = NonNullable<ProjectConfig["services"]>[string];

/** Orders every Component once; dependency validity/cycles are checked by Project validation. */
function dependencyOrder(components: PlanComponent[]): PlanComponent[] {
  const byName = new Map(
      components.map((component) => [component.name, component]),
    ),
    result: PlanComponent[] = [],
    seen = new Set<string>();
  const visit = (component: PlanComponent): void => {
    if (seen.has(component.name)) return;
    seen.add(component.name);
    for (const name of component.dependsOn) visit(byName.get(name)!);
    result.push(component);
  };
  for (const component of components) visit(component);
  return result;
}
/** Resolves portable Project policy into a materialized Target plan without reading files, the environment or ports.
 * The caller owns assigned port numbers (not live socket reservations), workspace/data roots, the actual Target name, and Branch/Commit identity;
 * `host` carries the operator home and convention-file root that env-file references are built from.
 * Every acquired root must be absolute; portable config paths resolve against the workspace.
 * The plan carries public values and env-file references only: file contents are composed per invocation by the execution adapter.
 * Throws ConfigError for relative roots, incomplete ports, invalid references, collisions, invalid resolved bindings, or settings this runtime cannot run yet.
 */
export function resolveTargetPlan(
  input: ResolveTargetPlanInput,
  host: ResolveHost,
): TargetPlan {
  for (const [field, value] of [
    ["workspacePath", input.workspacePath],
    ["dataRoot", input.dataRoot],
    ["operatorHome", host.operatorHome],
    ["envRoot", host.envRoot],
  ] as const)
    if (!isAbsolute(value))
      throw new ConfigError(
        `Target plan ${field} must be an absolute path.`,
        "relative_root",
        { field },
        "Supply absolute workspace, Persistent storage, operator home and env roots from discovery or runtime composition.",
      );
  const config = parseProjectConfig(input.config),
    role = input.target,
    settings = patchedSettings(config, role);
  const deploymentName =
    input.deploymentName ??
    (role === "preview" ? slug(input.branch ?? "preview") : role);
  const domain = roleHostname(
    config.domain,
    rolePatch(config, role).domain,
    role,
  );
  const resolvedDomain =
    domain && resolveHostname(domain, "domain", role, deploymentName);
  const services = Object.entries(settings.services ?? {});
  const ports = resolvePorts(services, input);
  // Each Service domain routes '/' of its own hostname to one port of its Service; validation refused an ambiguous one.
  const serviceDomains = roleServiceDomains(
    config.services,
    rolePatch(config, role).services,
    settings.services,
    role,
  ).map((entry): PlanServiceDomain => {
    const hostname = resolveHostname(
      entry,
      `services.${entry.service}.domain`,
      role,
      deploymentName,
    );
    const port = serviceDomainPort(
      entry.service,
      { host: entry.pattern, ...(entry.port ? { port: entry.port } : {}) },
      settings.services?.[entry.service]?.ports,
    );
    if ("problem" in port)
      throw new ConfigError(port.problem, "invalid_domain", {
        path: entry.path,
      });
    return {
      hostname,
      service: entry.service,
      port: ports[`services.${entry.service}.ports.${port.port}`]!,
    };
  });
  // Without a proxy, '/' is the one Service with one port: a hostname routes to it (validation refused a hostname with no
  // such Service), and without a hostname ${rig.url} still names it, as an explicit proxy would.
  const proxy = settings.proxy ?? defaultProxy(settings.services);
  const routes = proxy
    ? planRoutes(proxy, settings.services ?? {}, ports)
    : undefined;
  const root = routes?.find((route) => route.prefix === "/");
  const proxied = root?.service;
  const rootPort = root?.port;
  uniqueSites(
    [
      ...(resolvedDomain !== undefined && proxied
        ? [{ hostname: resolvedDomain, path: "domain" }]
        : []),
      ...serviceDomains.map(({ hostname, service }) => ({
        hostname,
        path: `services.${service}.domain`,
      })),
    ],
    role,
  );
  const references = referenceResolver(settings, {
    target: deploymentName,
    workspace: input.workspacePath,
    host: proxied && resolvedDomain ? resolvedDomain : "",
    url: !proxied
      ? ""
      : resolvedDomain
        ? `https://${resolvedDomain}`
        : `http://127.0.0.1:${rootPort}`,
    data: (service) => join(input.dataRoot, service),
    port: (service, port) => ports[`services.${service}.ports.${port}`]!,
  });
  /** A healthcheck's test with references resolved, as the one string the plan records; undefined without a test. A URL is
   * data for the HTTP probe; a shell command is quoted for /bin/sh; a `CMD` program and its arguments are resolved one by
   * one and quoted into a command that runs them unchanged. */
  const resolveTest = (
    settings: HealthcheckSettings,
    at: string,
  ): ResolvedText | undefined => {
    const test = healthcheckTest(settings);
    if (test === undefined) return undefined;
    if (test.kind === "exec") {
      const argv = test.argv.map((arg, index) =>
        references.text(arg, `${at}.${index + 1}`),
      );
      return {
        value: execCommand(argv.map((arg) => arg.value)),
        inputs: argv.flatMap((arg) => arg.inputs),
      };
    }
    if (test.kind === "url")
      return { value: references.text(test.url, at).value, inputs: [] };
    // A plain string that only reads as a URL once its references are resolved is the URL check too, as `ready` was.
    const text = references.text(test.command, `${at}${test.at}`);
    if (test.at === "" && isHealthUrl(text.value))
      return { value: text.value, inputs: [] };
    const command = references.shell(test.command, `${at}${test.at}`);
    // A shell command must never read as the URL check a plain string can be.
    if (isHealthUrl(command.value))
      throw new ConfigError(
        `${at}${test.at} runs a shell command that reads as a URL.`,
        "invalid_healthcheck",
        { path: `${at}${test.at}` },
        "Write an HTTP check as a plain string, such as test: http://127.0.0.1:${port}/health.",
      );
    return command;
  };
  /** Listed files, then the operator's optional all.env and role file for this scope. */
  const envFiles = (
    listed: string | string[] | undefined,
    at: string,
    scope: string[],
  ): EnvFileRef[] => [
    ...(listed === undefined ? [] : [listed].flat()).map((file) => ({
      path: envFilePath(references.text(file, at).value, at, input, host),
      required: true,
    })),
    ...["all", role].map((file) => ({
      path: join(host.envRoot, config.name, ...scope, `${file}.env`),
      required: false,
    })),
  ];
  const publicEnv = (values: Readonly<Record<string, string>>, at: string) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        references.text(value, `${at}.${key}`).value,
      ]),
    );
  const projectEnv = publicEnv(settings.environment ?? {}, "environment");
  const projectFiles = envFiles(settings.env_file, "env_file", []);
  const buildTimeout = (override: string | undefined) =>
    durationSeconds(override ?? settings.build_timeout ?? "10m");
  const builds: BuildUnit[] = [];
  const components: PlanComponent[] = [
    ...services.map(([name, service]): PlanComponent => {
      const at = `services.${name}`;
      const workingDir = planWorkingDir(service.working_dir);
      const run = references.shell(service.command, `${at}.command`);
      if (!localhostCommand(run.value))
        throw new ConfigError(
          "Resolved command binds outside localhost.",
          "invalid_binding",
          { service: name },
        );
      const check = healthcheckInForce(service.healthcheck)
        ? service.healthcheck
        : undefined;
      const ready = check && resolveTest(check, `${at}.healthcheck.test`);
      if (ready !== undefined && !localhostHealth(ready.value))
        throw new ConfigError(
          "Resolved healthcheck addresses a host outside localhost.",
          "invalid_binding",
          { service: name, field: "healthcheck.test" },
          `Point services.${name}.healthcheck.test at 127.0.0.1 or localhost.`,
        );
      const build =
        service.build === undefined
          ? undefined
          : references.shell(service.build, `${at}.build`);
      if (build)
        builds.push({
          id: `service:${name}`,
          component: name,
          command: build.value,
          timeout: buildTimeout(service.build_timeout),
        });
      const inputs = commandInputs(
        run.inputs,
        ready && !isHealthUrl(ready.value) ? ready.inputs : [],
        build?.inputs ?? [],
      );
      return {
        name,
        kind: "managed",
        env: {
          ...projectEnv,
          ...publicEnv(service.environment ?? {}, `${at}.environment`),
        },
        dependsOn: service.depends_on ?? [],
        envFiles: [
          ...projectFiles,
          ...envFiles(service.env_file, `${at}.env_file`, [name]),
        ],
        ...(inputs.length ? { commandInputs: inputs } : {}),
        command: run.value,
        ...(workingDir !== undefined ? { workingDir } : {}),
        ...declaredPorts(name, service, ports),
        readyTimeout: durationSeconds(
          check?.start_period ?? HEALTHCHECK_DEFAULTS.start_period,
        ),
        stopTimeout: durationSeconds(
          service.stop_timeout ?? `${DEFAULT_STOP_TIMEOUT_SECONDS}s`,
        ),
        restart: service.restart ?? DEFAULT_RESTART_POLICY,
        ...(ready !== undefined ? { health: ready.value } : {}),
        ...(check
          ? {
              healthcheck: {
                interval: durationSeconds(
                  check.interval ?? HEALTHCHECK_DEFAULTS.interval,
                ),
                timeout: durationSeconds(
                  check.timeout ?? HEALTHCHECK_DEFAULTS.timeout,
                ),
                retries: check.retries ?? HEALTHCHECK_DEFAULTS.retries,
                onFailure: check.on_failure ?? HEALTHCHECK_DEFAULTS.on_failure,
              },
            }
          : {}),
      };
    }),
    ...Object.entries(settings.tools ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, tool]): PlanComponent => {
        const at = `tools.${name}`;
        const build = tool.build
          ? references.shell(tool.build, `${at}.build`)
          : undefined;
        if (build)
          builds.push({
            id: `tool:${name}`,
            component: name,
            command: build.value,
            timeout: buildTimeout(tool.build_timeout),
          });
        return {
          name,
          kind: "installed",
          env: projectEnv,
          dependsOn: [],
          envFiles: projectFiles,
          ...(build?.inputs.length
            ? { commandInputs: commandInputs(build.inputs) }
            : {}),
          entrypoint: resolve(
            input.workspacePath,
            references.text(tool.bin, `${at}.bin`).value,
          ),
        };
      }),
  ];
  const ordered = dependencyOrder(components);
  // Every role plans every job, so rig run reaches it anywhere; its targets (the stable Target alone by default) decide
  // where the schedule runs it.
  const jobs = Object.entries(settings.jobs ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, job]): PlanJob => {
      const at = `jobs.${name}`;
      const run = references.shell(job.command, `${at}.command`);
      if (!localhostCommand(run.value))
        throw new ConfigError(
          "Resolved command binds outside localhost.",
          "invalid_binding",
          { job: name },
          `Point jobs.${name}.command at 127.0.0.1 or localhost.`,
        );
      const workingDir = planWorkingDir(job.working_dir);
      const restore =
        job.backup?.restore === undefined
          ? undefined
          : references.shell(job.backup.restore, `${at}.backup.restore`);
      if (restore && !localhostCommand(restore.value))
        throw new ConfigError(
          "Resolved restore command binds outside localhost.",
          "invalid_binding",
          { job: name },
          `Point jobs.${name}.backup.restore at 127.0.0.1 or localhost.`,
        );
      // The restore runs in the job's environment, so a file may change no public input it was built from either.
      const inputs = commandInputs(run.inputs, restore?.inputs ?? []);
      return {
        name,
        command: run.value,
        ...(workingDir !== undefined ? { workingDir } : {}),
        env: {
          ...projectEnv,
          ...publicEnv(job.environment ?? {}, `${at}.environment`),
        },
        envFiles: [
          ...projectFiles,
          ...envFiles(job.env_file, `${at}.env_file`, [name]),
        ],
        ...(inputs.length ? { commandInputs: inputs } : {}),
        schedule: job.schedule,
        ...((job.targets ?? DEFAULT_JOB_TARGETS).includes(role)
          ? {}
          : { scheduled: false as const }),
        ...(job.timezone !== undefined ? { timeZone: job.timezone } : {}),
        ...(job.timeout !== undefined
          ? { timeout: durationSeconds(job.timeout) }
          : {}),
        ...(job.stop_timeout !== undefined
          ? { stopTimeout: durationSeconds(job.stop_timeout) }
          : {}),
        ...(job.backup
          ? {
              backup: {
                keep: job.backup.keep,
                ...(restore ? { restore: restore.value } : {}),
              },
            }
          : {}),
      };
    });
  const shared =
    settings.build === undefined
      ? undefined
      : references.shell(settings.build, "build");
  // Shared work first, then each Component's unit in plan order: Services by dependency, then Tools by name.
  const units: BuildUnit[] = [
    ...(shared
      ? [
          {
            id: "shared",
            command: shared.value,
            timeout: buildTimeout(undefined),
            ...(shared.inputs.length
              ? { commandInputs: commandInputs(shared.inputs) }
              : {}),
          },
        ]
      : []),
    ...ordered.flatMap((component) =>
      builds.filter((unit) => unit.component === component.name),
    ),
  ];
  return {
    project: config.name,
    target: input.target,
    workspacePath: input.workspacePath,
    dataRoot: input.dataRoot,
    deploymentName,
    branchSlug: deploymentName,
    subdomain: deploymentName,
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    providers: { processSupervisor: "rigd" },
    env: projectEnv,
    envFiles: projectFiles,
    components: ordered,
    ...(jobs.length ? { jobs } : {}),
    ...(units.length ? { builds: units } : {}),
    preparedComponents: [],
    ...(resolvedDomain !== undefined && proxied
      ? {
          domain: resolvedDomain,
          proxy: { upstream: proxied, routes: routes! },
        }
      : {}),
    ...(serviceDomains.length ? { serviceDomains } : {}),
  };
}

/** The route map with concrete ports, longest prefix first so the first match is the most specific one. */
function planRoutes(
  proxy: Readonly<Record<string, string>>,
  services: NonNullable<ProjectConfig["services"]>,
  ports: Readonly<Record<string, number>>,
): PlanRoute[] {
  return Object.entries(proxy)
    .map(([prefix, reference]) => {
      const upstream = proxyUpstream(reference, services);
      // Project validation refuses an upstream that names no declared port.
      if ("problem" in upstream)
        throw new ConfigError(
          `Proxy '${prefix}': ${upstream.problem}.`,
          "invalid_proxy",
          { prefix },
          "Name a Service with one port, or one of its ports, such as ${services.web.ports.http}.",
        );
      return {
        // '/api/' and '/api' are one prefix: both match '/api' and everything below it.
        prefix: prefix === "/" ? prefix : prefix.replace(/\/+$/, ""),
        service: upstream.service,
        port: ports[`services.${upstream.service}.ports.${upstream.port}`]!,
      };
    })
    .sort(
      (a, b) =>
        b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : 1),
    );
}
/** A Service's concrete ports as the plan records them: all of them by name, and the first for status. */
function declaredPorts(
  name: string,
  service: Service,
  ports: Readonly<Record<string, number>>,
): Pick<ManagedComponent, "port" | "ports"> {
  const named = Object.fromEntries(
    Object.keys(service.ports ?? {}).map((port) => [
      port,
      ports[`services.${name}.ports.${port}`]!,
    ]),
  );
  const first = Object.values(named)[0];
  return first === undefined ? {} : { port: first, ports: named };
}

/** The longest DNS label: a hostname part between two dots. */
const MAX_LABEL_LENGTH = 63;
/** One role's hostname with `${rig.target}` replaced by the Target's name. `setting` is the top-level path of the setting
 * it comes from, such as domain or services.api.domain. Throws ConfigError `hostname_label_too_long` for a label DNS
 * cannot hold, never cutting it short, and `invalid_domain` for a result that is no hostname. */
function resolveHostname(
  hostname: RoleHostname,
  setting: string,
  role: ResolveTargetPlanInput["target"],
  deploymentName: string,
): string {
  const resolved = hostname.pattern.replaceAll("${rig.target}", deploymentName);
  const path = hostname.patched ? `targets.${role}.${setting}` : setting;
  const longLabel = resolved
    .split(".")
    .find((label) => label.length > MAX_LABEL_LENGTH);
  const service = /^services\.([^.]+)\.domain$/.exec(setting)?.[1];
  if (longLabel !== undefined)
    throw new ConfigError(
      `Hostname '${resolved}' has a ${longLabel.length}-character label, '${longLabel}'; DNS allows ${MAX_LABEL_LENGTH}.`,
      "hostname_label_too_long",
      { domain: resolved, label: longLabel, path },
      role === "preview" && !hostname.patched
        ? `A Preview's default hostname puts its name inside the first label of ${setting}. Deploy from a shorter Branch name, give the Preview a shorter --deployment name, or set targets.preview.${setting} to a pattern such as \${rig.target}.${service ? `${service}.` : ""}preview.example.com.`
        : `Shorten that label in ${path}, or deploy from a shorter Branch name when the label holds \${rig.target}.`,
    );
  if (!validHostname(resolved))
    throw new ConfigError(
      service
        ? `The domain '${resolved}' of Service '${service}' is not a hostname.`
        : `Domain '${resolved}' is not a hostname.`,
      "invalid_domain",
      { domain: resolved, path: service ? path : "domain" },
      "Use a hostname such as app.test or ${rig.target}.app.test; schemes, ports, paths, wildcards and lists are not allowed.",
    );
  return resolved;
}
/** Refuses a Target that would serve one hostname twice, which Caddy cannot route: its domain and a Service domain, or
 * two Service domains, after `${rig.target}` is replaced. Hostnames compare without case, as DNS does. */
function uniqueSites(
  sites: readonly { hostname: string; path: string }[],
  role: ResolveTargetPlanInput["target"],
): void {
  const seen = new Map<string, string>();
  for (const { hostname, path } of sites) {
    const first = seen.get(hostname.toLowerCase());
    if (first !== undefined)
      throw new ConfigError(
        `The ${role} Target would serve ${hostname} twice, from ${first} and ${path}.`,
        "duplicate_hostname",
        { hostname, paths: [first, path] },
        "Give every hostname of a Target its own value: change one of the two settings.",
      );
    seen.set(hostname.toLowerCase(), path);
  }
}
/** A Branch as a hostname label, for a Preview the caller did not name. */
function slug(branch: string): string {
  return (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "preview"
  );
}
/** Every public env leaf a Component's commands were built from, once per config path. */
function commandInputs(...lists: readonly PublicInput[][]): PublicInput[] {
  return [
    ...new Map(lists.flat().map((input) => [input.source, input])).values(),
  ];
}
/** An env_file path made absolute: `~` is the operator home, an absolute path stays, and a relative path resolves against the workspace.
 * A deployed Target's relative path that leaves its checkout is ConfigError `path_outside_target`: it would name rigd's own storage beside the revision;
 * operator files are addressed absolutely or through `~`. The developer's Working copy keeps whatever relative path they wrote. */
function envFilePath(
  value: string,
  at: string,
  input: Pick<ResolveTargetPlanInput, "target" | "workspacePath">,
  host: Pick<ResolveHost, "operatorHome">,
): string {
  if (value === "~" || value.startsWith("~/"))
    return join(host.operatorHome, value.slice(1));
  if (value.startsWith("~"))
    throw new ConfigError(
      `${at} '${value}' names another user's home.`,
      "invalid_path",
      { field: at },
      "Use ~/ for the operator home, or an absolute path.",
    );
  if (isAbsolute(value)) return value;
  const root = input.workspacePath,
    path = resolve(root, value),
    inside = relative(root, path);
  if (
    input.target !== "working" &&
    (inside === "" || inside.startsWith("..") || isAbsolute(inside))
  )
    throw new ConfigError(
      `${at} '${value}' resolves outside the Target's workspace (${root}).`,
      "path_outside_target",
      { field: at, path, root },
      `Give ${at} a relative path inside the Target, or address an operator file absolutely or under ~/.`,
    );
  return path;
}

/** Chooses every declared port's concrete number: a pin wins outside Previews, otherwise the caller's assignment, which is
 * keyed `<service>.<port>`. An assignment recorded before named ports is keyed by the Service alone and means its first port. */
function resolvePorts(
  services: readonly (readonly [string, Service])[],
  input: Pick<ResolveTargetPlanInput, "target" | "assignedPorts">,
): Record<string, number> {
  const owners = new Map<number, string>(),
    resolved: Record<string, number> = {};
  for (const [name, service] of services) {
    const declared = Object.entries(service.ports ?? {});
    for (const [index, [port, configured]] of declared.entries()) {
      const assigned =
          input.assignedPorts?.[`${name}.${port}`] ??
          (index === 0 ? input.assignedPorts?.[name] : undefined),
        pinned = configured === "auto" ? undefined : configured,
        value = input.target === "preview" ? assigned : (pinned ?? assigned);
      if (
        value === undefined ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 65535
      )
        throw new ConfigError(
          `Service '${name}' needs a valid assigned port for '${port}'.`,
          "missing_port",
          { service: name, port },
        );
      if (owners.has(value))
        throw new ConfigError(
          `Port ${value} is used by more than one Service.`,
          "port_collision",
          { services: [owners.get(value), name], port: value },
        );
      owners.set(value, name);
      resolved[`services.${name}.ports.${port}`] = value;
    }
  }
  return resolved;
}
