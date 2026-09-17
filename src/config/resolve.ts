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
  validHostname,
} from "./schema.js";
import type {
  ProjectConfig,
  PlanComponent,
  ResolveTargetPlanInput,
  TargetPlan,
} from "./types.js";
type Properties = Record<string, string | number>;
type TargetKind = ResolveTargetPlanInput["target"];
type Service = NonNullable<ProjectConfig["services"]>[string];

const shellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const shellSafe = /^[A-Za-z0-9_/.:@%+=,-]*$/;
/** Pure substitution: unknown names fail, naming the config field `at`, instead of becoming empty strings; shell ${ENV} stays explicit only through env. */
function interpolate(
  value: string,
  properties: Properties,
  at: string,
): string {
  return substitute(value, properties, at, (result) => result);
}
/** Substitution for text that /bin/sh -c will run: a value that would split or expand is single-quoted unless the author already quoted the placeholder. */
function interpolateShell(
  value: string,
  properties: Properties,
  at: string,
): string {
  return substitute(value, properties, at, (result, offset) =>
    shellSafe.test(result) || insideShellQuotes(value.slice(0, offset))
      ? result
      : shellArg(result),
  );
}
function substitute(
  value: string,
  properties: Properties,
  at: string,
  render: (result: string, offset: number) => string,
): string {
  return value.replace(
    /\$\{([^}]+)\}/g,
    (match: string, key: string, offset: number) => {
      const result = Object.hasOwn(properties, key.trim())
        ? properties[key.trim()]
        : undefined;
      if (result === undefined)
        throw new ConfigError(
          `Unknown reference '${match}' in ${at}.`,
          "unknown_reference",
          { key, path: at },
          "A reference names a declared port such as ${services.web.ports.http} or a Rig value such as ${rig.target}; shell expansion such as ${VAR:-default} belongs in env, an env_file, or a script the command runs.",
        );
      return render(String(result), offset);
    },
  );
}
/** Whether a position in shell text sits inside an open single or double quote. */
function insideShellQuotes(prefix: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === "\\") i++;
    else if (quote === '"') {
      if (char === '"') quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
  }
  return quote !== undefined;
}
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
/** Settings the recorded Target plan cannot carry until their owning runtime work lands; refusing beats silently dropping policy. */
function unsupported(setting: string, path: string): ConfigError {
  return new ConfigError(
    `${setting} is not supported by this runtime yet.`,
    "unsupported_setting",
    { path },
    `Remove ${path} for now; the configuration is valid, but this build of rigd cannot run it.`,
  );
}
/** Resolves portable Project policy into a materialized Target plan without reading files or allocating ports.
 * The caller owns assigned port numbers (not live socket reservations), workspace/data roots, the actual Target name, and Branch/Commit identity.
 * Both acquired roots must be absolute; portable config paths may remain relative.
 * Throws ConfigError for relative roots, incomplete ports, unknown references, collisions, invalid resolved bindings, or settings this runtime cannot run yet.
 */
export function resolveTargetPlan(input: ResolveTargetPlanInput): TargetPlan {
  for (const field of ["workspacePath", "dataRoot"] as const)
    if (!isAbsolute(input[field]))
      throw new ConfigError(
        `Target plan ${field} must be an absolute path.`,
        "relative_root",
        { field },
        "Supply absolute workspace and Persistent storage roots from discovery or runtime composition.",
      );
  const config = parseProjectConfig(input.config),
    role = ROLE_OF[input.target],
    settings = patchedSettings(config, role);
  const deploymentName =
    input.deploymentName ??
    (role === "preview"
      ? slug(input.branch ?? "preview")
      : targetNames(config)[role]);
  if (settings.build !== undefined)
    throw unsupported("A shared build", "build");
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
  const proxied = settings.proxy ? proxyService(settings.proxy) : undefined;
  const rootPort = proxied ? ports[`services.${proxied}.ports`] : undefined;
  const properties: Properties = {
    ...Object.fromEntries(
      services.flatMap(([name, service]) =>
        Object.keys(service.ports ?? {}).map((port) => [
          `services.${name}.ports.${port}`,
          ports[`services.${name}.ports`]!,
        ]),
      ),
    ),
    "rig.target": deploymentName,
    "rig.workspace": input.workspacePath,
    "rig.host": proxied && resolvedDomain ? resolvedDomain : "",
    "rig.url": !proxied
      ? ""
      : resolvedDomain
        ? `https://${resolvedDomain}`
        : `http://127.0.0.1:${rootPort}`,
  };
  const envFile = (
    value: string | string[] | undefined,
    at: string,
  ): string | undefined => {
    const files = value === undefined ? [] : [value].flat();
    if (files.length > 1) throw unsupported("A list of env files", at);
    if (files[0]?.startsWith("~"))
      throw unsupported("An env file under the operator's home (~)", at);
    return files[0] === undefined
      ? undefined
      : targetPath(
          input.target,
          input.workspacePath,
          interpolate(files[0], properties, at),
          at,
        );
  };
  const projectEnvFile = envFile(settings.env_file, "env_file");
  const projectSupervisor = settings.supervisor ?? "rigd";
  const components: PlanComponent[] = [
    ...services.map(([name, service]): PlanComponent => {
      const at = `services.${name}`;
      if (service.build !== undefined)
        throw unsupported("A Service build", `${at}.build`);
      if (service.workdir !== undefined)
        throw unsupported("A Service workdir", `${at}.workdir`);
      if ((service.restart ?? "always") !== "always")
        throw unsupported(
          "A restart policy other than always",
          `${at}.restart`,
        );
      if ((service.supervisor ?? projectSupervisor) !== projectSupervisor)
        throw unsupported("A per-Service supervisor", `${at}.supervisor`);
      const scoped = { ...properties, "rig.data": join(input.dataRoot, name) };
      const run = interpolateShell(service.run, scoped, `${at}.run`);
      if (!localhostCommand(run))
        throw new ConfigError(
          "Resolved run command binds outside localhost.",
          "invalid_binding",
          { service: name },
        );
      const ready =
        service.ready === undefined
          ? undefined
          : interpolateShell(service.ready, scoped, `${at}.ready`);
      if (ready !== undefined && !localhostHealth(ready))
        throw new ConfigError(
          "Resolved readiness check addresses a host outside localhost.",
          "invalid_binding",
          { service: name, field: "ready" },
        );
      const file =
        envFile(service.env_file, `${at}.env_file`) ?? projectEnvFile;
      return {
        name,
        kind: "managed",
        env: Object.fromEntries(
          Object.entries({ ...settings.env, ...service.env }).map(
            ([key, value]) => [
              key,
              interpolate(value, scoped, `${at}.env.${key}`),
            ],
          ),
        ),
        dependsOn: service.depends_on ?? [],
        ...(file ? { envFile: file } : {}),
        command: run,
        port: ports[`services.${name}.ports`]!,
        readyTimeout: durationSeconds(service.ready_timeout ?? "30s"),
        ...(ready !== undefined ? { health: ready } : {}),
      };
    }),
    ...Object.entries(settings.tools ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, tool]): PlanComponent => {
        const at = `tools.${name}`;
        const timeout = tool.build_timeout ?? settings.build_timeout;
        return {
          name,
          kind: "installed",
          env: Object.fromEntries(
            Object.entries(settings.env ?? {}).map(([key, value]) => [
              key,
              interpolate(value, properties, `env.${key}`),
            ]),
          ),
          dependsOn: [],
          ...(projectEnvFile ? { envFile: projectEnvFile } : {}),
          entrypoint: resolve(
            input.workspacePath,
            interpolate(tool.bin, properties, `${at}.bin`),
          ),
          ...(tool.build
            ? { build: interpolateShell(tool.build, properties, `${at}.build`) }
            : {}),
          ...(timeout ? { buildTimeout: durationSeconds(timeout) } : {}),
        };
      }),
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
    providerProfile: "default",
    providers: { processSupervisor: projectSupervisor },
    components: dependencyOrder(components),
    preparedComponents: [],
    ...(resolvedDomain !== undefined && proxied
      ? { domain: resolvedDomain, proxy: { upstream: proxied } }
      : {}),
  };
}

/** The one Service a recorded plan can route: the '/' upstream. */
function proxyService(proxy: Readonly<Record<string, string>>): string {
  const extra = Object.keys(proxy).find((prefix) => prefix !== "/");
  if (extra !== undefined)
    throw unsupported("A proxy prefix other than '/'", `proxy.${extra}`);
  return proxyUpstream(proxy["/"]!)!.service;
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
/** Resolves an env file against the workspace. Deployed Targets own their workspace,
 * so a path that lands outside it is rejected as ConfigError `path_outside_target`; the developer's
 * Working copy keeps whatever path they wrote.
 */
function targetPath(
  target: TargetKind,
  root: string,
  value: string,
  at: string,
): string {
  const path = resolve(root, value),
    inside = relative(root, path);
  if (
    target !== "local" &&
    (inside === "" || inside.startsWith("..") || isAbsolute(inside))
  )
    throw new ConfigError(
      `${at} '${value}' resolves outside the Target's workspace (${root}).`,
      "path_outside_target",
      { field: at, path, root },
      `Give ${at} a relative path inside the Target; rigd only creates, protects, and destroys files it owns.`,
    );
  return path;
}

/** Chooses each Service's one concrete port: a pin wins outside Previews, otherwise the caller's assignment. */
function resolvePorts(
  services: readonly (readonly [string, Service])[],
  input: Pick<ResolveTargetPlanInput, "target" | "assignedPorts">,
): Record<string, number> {
  const owners = new Map<number, string>(),
    resolved: Record<string, number> = {};
  for (const [name, service] of services) {
    const declared = Object.entries(service.ports ?? {});
    if (declared.length !== 1)
      throw unsupported(
        declared.length
          ? "A Service with several ports"
          : "A Service without a port",
        `services.${name}.ports`,
      );
    const [port, configured] = declared[0]!;
    const assigned = input.assignedPorts?.[name],
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
    resolved[`services.${name}.ports`] = value;
  }
  return resolved;
}
