import { isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "./errors.js";
import { parseProjectConfig, localhostCommand } from "./schema.js";
import type {
  Hooks,
  ProjectConfig,
  PlanComponent,
  PreparedComponent,
  ResolveTargetPlanInput,
  TargetPlan,
} from "./types.js";
type Properties = Record<string, string | number>;
type Component = ProjectConfig["components"][string];
type Lane = NonNullable<ProjectConfig["local"]>;
interface Definition {
  name: string;
  component: Component;
}

const shellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Pure substitution: unknown names fail instead of becoming empty strings; shell ${ENV} stays explicit only through env. */
function interpolate(value: string, properties: Properties): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    const result = Object.hasOwn(properties, key.trim())
      ? properties[key.trim()]
      : undefined;
    if (result === undefined)
      throw new ConfigError(
        `Unknown interpolation '${key}'.`,
        "unknown_interpolation",
        { key },
      );
    return String(result);
  });
}
function resolveHooks(
  hooks: Hooks | undefined,
  properties: Properties,
): Hooks | undefined {
  return hooks
    ? Object.fromEntries(
        Object.entries(hooks).map(([key, value]) => [
          key,
          interpolate(value, properties),
        ]),
      )
    : undefined;
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
/** Resolves portable Project policy into a materialized Target plan without reading files or allocating ports.
 * The caller owns assigned-port reservations, workspace/data roots, and Branch/Commit identity.
 * Both acquired roots must be absolute; portable config paths may remain relative.
 * Throws ConfigError for relative roots, incomplete ports, unsupported interpolation, collisions, or invalid resolved bindings.
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
    lane =
      input.target === "local"
        ? config.local
        : input.target === "live"
          ? config.live
          : config.deployments;
  const deploymentName =
    input.deploymentName ??
    (input.target === "preview"
      ? (input.branchSlug ?? input.branch ?? "preview")
      : input.target);
  const branchSlug =
    input.branchSlug ??
    input.branch?.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase() ??
    deploymentName;
  const properties: Properties = {
    lane: input.target === "preview" ? "deployment" : input.target,
    target: input.target,
    workspace: input.workspacePath,
    dataRoot: input.dataRoot,
    deployment: deploymentName,
    branchSlug,
    subdomain: branchSlug,
  };
  const subdomain = interpolate(
    input.subdomain ?? lane?.subdomain ?? branchSlug,
    properties,
  );
  properties.subdomain = subdomain;
  const definitions = Object.entries(config.components).map(
    ([name, component]) => ({
      name,
      component: { ...component, ...lane?.components?.[name] } as Component,
    }),
  );
  const { properties: resolvedProperties, preparedComponents } =
    resolveComponentProperties(definitions, input, properties);
  Object.assign(properties, resolvedProperties);
  const components = definitions.map(({ name, component }) =>
    resolvePlanComponent({
      name,
      component,
      shared: config.components[name]!,
      lane,
      workspacePath: input.workspacePath,
      properties,
    }),
  );
  const domain = lane?.domain ?? config.domain;
  return {
    project: config.name,
    target: input.target,
    workspacePath: input.workspacePath,
    dataRoot: input.dataRoot,
    deploymentName,
    branchSlug,
    subdomain,
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    providerProfile: lane?.providerProfile ?? "default",
    ...(lane?.env
      ? {
          env: Object.fromEntries(
            Object.entries(lane.env).map(([key, value]) => [
              key,
              interpolate(value, properties),
            ]),
          ),
        }
      : {}),
    ...(lane?.daemon ? { daemon: lane.daemon } : {}),
    providers: {
      processSupervisor: lane?.providers?.processSupervisor ?? "rigd",
    },
    components: dependencyOrder(components),
    preparedComponents,
    ...(domain ? { domain: interpolate(domain, properties) } : {}),
    ...(lane?.proxy ? { proxy: lane.proxy } : {}),
    ...(config.hooks ? { hooks: resolveHooks(config.hooks, properties) } : {}),
    ...(lane?.envFile
      ? {
          envFile: resolve(
            input.workspacePath,
            interpolate(lane.envFile, properties),
          ),
        }
      : {}),
  };
}

/** Computes concrete ports and prepared storage before commands read their properties. */
function resolveComponentProperties(
  definitions: readonly Definition[],
  input: Pick<
    ResolveTargetPlanInput,
    "target" | "assignedPorts" | "workspacePath" | "dataRoot"
  >,
  baseProperties: Properties,
): { properties: Properties; preparedComponents: PreparedComponent[] } {
  const properties = { ...baseProperties };
  const ports = new Map<number, string>(),
    preparedComponents: PreparedComponent[] = [];
  const reserve = (name: string, configured: number | undefined): number => {
    const assigned = input.assignedPorts?.[name],
      value =
        input.target === "preview"
          ? (assigned ?? configured)
          : (configured ?? assigned);
    if (
      value === undefined ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 65535
    )
      throw new ConfigError(
        `Component '${name}' needs a valid assigned port.`,
        "missing_port",
        { component: name },
      );
    if (ports.has(value))
      throw new ConfigError(
        `Port ${value} is used by more than one Component.`,
        "port_collision",
        { components: [ports.get(value), name], port: value },
      );
    ports.set(value, name);
    properties[`${name}.port`] = value;
    properties[`ports.${name}`] = value;
    properties[`port.${name}`] = value;
    properties[`${name}.url`] = `http://127.0.0.1:${value}`;
    return value;
  };
  // Resolve all stable properties before interpolating commands, so declaration order has no meaning.
  for (const { name, component } of definitions) {
    if (
      ("mode" in component && component.mode === "managed") ||
      ("uses" in component && component.uses !== "sqlite")
    ) {
      const port = reserve(name, component.port);
      if ("uses" in component && component.uses === "convex") {
        const sitePort = reserve(
          `${name}.site`,
          component.sitePort ?? port + 1,
        );
        Object.assign(properties, {
          [`${name}.sitePort`]: sitePort,
          [`${name}.siteUrl`]: `http://127.0.0.1:${sitePort}`,
          [`${name}.stateDir`]: join(
            input.workspacePath,
            ".convex/local/default",
          ),
        });
        preparedComponents.push({
          name,
          uses: "convex",
          stateDir: String(properties[`${name}.stateDir`]),
        });
      }
      if ("uses" in component && component.uses === "postgres") {
        properties[`${name}.dataDir`] = join(input.dataRoot, "postgres", name);
        preparedComponents.push({
          name,
          uses: "postgres",
          dataDir: String(properties[`${name}.dataDir`]),
        });
      }
    }
  }
  for (const { name, component } of definitions)
    if ("uses" in component && component.uses === "sqlite") {
      const path = resolve(
        input.workspacePath,
        interpolate(
          component.path ?? join(input.dataRoot, "sqlite", `${name}.sqlite`),
          properties,
        ),
      );
      properties[`${name}.path`] = path;
      preparedComponents.push({ name, uses: "sqlite", path });
    }
  return { properties, preparedComponents };
}

/** Resolves one Component's complete runtime policy from already resolved Target properties. */
function resolvePlanComponent({
  name,
  component,
  shared,
  lane,
  workspacePath,
  properties,
}: {
  name: string;
  component: Component;
  shared: Component;
  lane: Lane | undefined;
  workspacePath: string;
  properties: Properties;
}): PlanComponent {
  const env = Object.fromEntries(
    Object.entries({
      ...lane?.env,
      ...("env" in shared ? shared.env : {}),
      ...lane?.components?.[name]?.env,
    }).map(([key, value]) => [key, interpolate(value, properties)]),
  );
  const envFile =
    "envFile" in component
      ? (component.envFile ?? lane?.envFile)
      : lane?.envFile;
  const common = {
    name,
    env,
    dependsOn:
      ("dependsOn" in component ? component.dependsOn : undefined) ?? [],
    ...("hooks" in component && component.hooks
      ? { hooks: resolveHooks(component.hooks, properties) }
      : {}),
    ...(envFile
      ? {
          envFile: resolve(workspacePath, interpolate(envFile, properties)),
        }
      : {}),
  };
  if ("uses" in component && component.uses === "sqlite")
    return {
      ...common,
      kind: "persistent" as const,
      uses: "sqlite" as const,
      path: String(properties[`${name}.path`]),
    };
  if ("mode" in component && component.mode === "installed")
    return {
      ...common,
      kind: "installed" as const,
      entrypoint: resolve(
        workspacePath,
        interpolate(component.entrypoint, properties),
      ),
      ...(component.build
        ? { build: interpolate(component.build, properties) }
        : {}),
      ...(component.installName ? { installName: component.installName } : {}),
    };
  const port = Number(properties[`${name}.port`]),
    plugin = "uses" in component ? component.uses : undefined;
  let command = component.command,
    health = component.health;
  if (plugin === "convex") {
    command ??= `bunx convex dev --local --local-cloud-port ${port} --local-site-port ${properties[`${name}.sitePort`]}`;
    health ??= `http://127.0.0.1:${port}/instance_name`;
  }
  if (plugin === "postgres") {
    command ??= `sh -c 'test -f "$1/PG_VERSION" || initdb -D "$1" || exit; exec postgres -D "$1" -h 127.0.0.1 -p "$2"' -- ${shellArg(String(properties[`${name}.dataDir`]))} ${port}`;
    health ??= `pg_isready -h 127.0.0.1 -p ${port}`;
  }
  const resolvedCommand = interpolate(command!, properties);
  if (!localhostCommand(resolvedCommand))
    throw new ConfigError(
      "Resolved command binds outside localhost.",
      "invalid_binding",
      { component: name },
    );
  return {
    ...common,
    kind: "managed" as const,
    port,
    command: resolvedCommand,
    readyTimeout: component.readyTimeout ?? (plugin ? 60 : 30),
    ...(health ? { health: interpolate(health, properties) } : {}),
    ...(plugin === "convex"
      ? { sitePort: Number(properties[`${name}.sitePort`]) }
      : {}),
  };
}
