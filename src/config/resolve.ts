import { isAbsolute, join, relative, resolve } from "node:path";
import { ConfigError } from "./errors.js";
import {
  durationSeconds,
  parseProjectConfig,
  patchedSettings,
  proxyUpstream,
  targetNames,
  localhostCommand,
  localhostHealth,
  isHealthUrl,
  validHostname,
} from "./schema.js";
import { referenceResolver, type PublicInput } from "./references.js";
import type {
  BuildUnit,
  EnvFileRef,
  ManagedComponent,
  PlanRoute,
  ProjectConfig,
  PlanComponent,
  ResolveHost,
  ResolveTargetPlanInput,
  TargetPlan,
} from "./types.js";
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
const ROLE_OF = {
  local: "working",
  live: "stable",
  preview: "preview",
} as const;
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
    role = ROLE_OF[input.target],
    settings = patchedSettings(config, role);
  const deploymentName =
    input.deploymentName ??
    (role === "preview"
      ? slug(input.branch ?? "preview")
      : targetNames(config)[role]);
  const domain =
    role === "stable" || config.targets?.[role]?.domain
      ? settings.domain
      : role === "preview" && config.domain
        ? `\${rig.target}.${config.domain}`
        : undefined;
  const resolvedDomain = domain?.replaceAll("${rig.target}", deploymentName);
  if (resolvedDomain !== undefined && !validHostname(resolvedDomain))
    throw new ConfigError(
      `Domain '${resolvedDomain}' is not a hostname.`,
      "invalid_domain",
      { domain: resolvedDomain, path: "domain" },
      "Use a hostname such as app.test or ${rig.target}.app.test; schemes, ports, paths, wildcards and lists are not allowed.",
    );
  const services = Object.entries(settings.services ?? {});
  const ports = resolvePorts(services, input);
  const routes = settings.proxy ? planRoutes(settings.proxy, ports) : undefined;
  const root = routes?.find((route) => route.prefix === "/");
  const proxied = root?.service;
  const rootPort = root?.port;
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
  const projectEnv = publicEnv(settings.env ?? {}, "env");
  const projectFiles = envFiles(settings.env_file, "env_file", []);
  const projectSupervisor = settings.supervisor ?? "rigd";
  const buildTimeout = (override: string | undefined) =>
    durationSeconds(override ?? settings.build_timeout ?? "10m");
  const builds: BuildUnit[] = [];
  const components: PlanComponent[] = [
    ...services.map(([name, service]): PlanComponent => {
      const at = `services.${name}`;
      const run = references.shell(service.run, `${at}.run`);
      if (!localhostCommand(run.value))
        throw new ConfigError(
          "Resolved run command binds outside localhost.",
          "invalid_binding",
          { service: name },
        );
      // A readiness URL is data for the HTTP probe; only a shell check is quoted for /bin/sh.
      const probe =
        service.ready === undefined
          ? undefined
          : references.text(service.ready, `${at}.ready`);
      const ready =
        probe === undefined || isHealthUrl(probe.value)
          ? probe
          : references.shell(service.ready!, `${at}.ready`);
      if (ready !== undefined && !localhostHealth(ready.value))
        throw new ConfigError(
          "Resolved readiness check addresses a host outside localhost.",
          "invalid_binding",
          { service: name, field: "ready" },
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
        env: { ...projectEnv, ...publicEnv(service.env ?? {}, `${at}.env`) },
        dependsOn: service.depends_on ?? [],
        envFiles: [
          ...projectFiles,
          ...envFiles(service.env_file, `${at}.env_file`, [name]),
        ],
        ...(inputs.length ? { commandInputs: inputs } : {}),
        command: run.value,
        ...declaredPorts(name, service, ports),
        readyTimeout: durationSeconds(service.ready_timeout ?? "30s"),
        restart: service.restart ?? "always",
        ...(ready !== undefined ? { health: ready.value } : {}),
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
    providers: { processSupervisor: projectSupervisor },
    env: projectEnv,
    envFiles: projectFiles,
    components: ordered,
    ...(units.length ? { builds: units } : {}),
    preparedComponents: [],
    ...(resolvedDomain !== undefined && proxied
      ? {
          domain: resolvedDomain,
          proxy: { upstream: proxied, routes: routes! },
        }
      : {}),
  };
}

/** The route map with concrete ports, longest prefix first so the first match is the most specific one. */
function planRoutes(
  proxy: Readonly<Record<string, string>>,
  ports: Readonly<Record<string, number>>,
): PlanRoute[] {
  return Object.entries(proxy)
    .map(([prefix, reference]) => {
      const upstream = proxyUpstream(reference)!;
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
    input.target !== "local" &&
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
