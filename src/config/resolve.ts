import { isAbsolute, join, relative, resolve } from "node:path";
import { ConfigError } from "./errors.js";
import { mergeComponentOverride } from "./override.js";
import {
  parseProjectConfig,
  localhostCommand,
  localhostHealth,
  validHostname,
} from "./schema.js";
import type {
  Hooks,
  ProjectConfig,
  PlanComponent,
  PreparedComponent,
  ResolveTargetPlanInput,
  TargetPlan,
} from "./types.js";
type Properties = Record<string, string | number>;
type TargetKind = ResolveTargetPlanInput["target"];
type Component = ProjectConfig["components"][string];
type Lane = NonNullable<ProjectConfig["local"]>;
interface Definition {
  name: string;
  component: Component;
}

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
          `Unknown interpolation '${match}' in ${at}.`,
          "unknown_interpolation",
          { key, path: at },
          "Interpolation names a Rig property such as ${web.port} or ${subdomain}; shell expansion such as ${VAR:-default} belongs in env, an envFile, or a script the command runs.",
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
/** Interpolates hook commands and, like Component commands, rejects a resolved hook that binds outside localhost. */
function resolveHooks(
  hooks: Hooks | undefined,
  properties: Properties,
  owner: string | undefined,
): Hooks | undefined {
  return hooks
    ? Object.fromEntries(
        Object.entries(hooks).map(([key, value]) => {
          const resolved = interpolateShell(
            value,
            properties,
            `${owner ? `components.${owner}.` : ""}hooks.${key}`,
          );
          if (!localhostCommand(resolved))
            throw new ConfigError(
              `Resolved ${key} hook binds outside localhost.`,
              "invalid_binding",
              { ...(owner ? { component: owner } : {}), hook: key },
            );
          return [key, resolved];
        }),
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
 * The caller owns assigned port numbers (not live socket reservations), workspace/data roots, and Branch/Commit identity.
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
    "subdomain",
  );
  properties.subdomain = subdomain;
  const definitions = Object.entries(config.components).map(
    ([name, component]) => ({
      name,
      component: mergeComponentOverride(
        component,
        lane?.components?.[name],
      ) as Component,
    }),
  );
  const { properties: resolvedProperties, preparedComponents } =
    resolveComponentProperties(definitions, input, properties);
  Object.assign(properties, resolvedProperties);
  const envFile = lane?.envFile
    ? targetPath(
        input.target,
        input.workspacePath,
        interpolate(lane.envFile, properties, "envFile"),
        { field: "envFile" },
      )
    : undefined;
  const components = definitions.map(({ name, component }) =>
    resolvePlanComponent({
      name,
      component,
      shared: config.components[name]!,
      lane,
      target: input.target,
      workspacePath: input.workspacePath,
      properties,
    }),
  );
  const domain = lane?.domain ?? config.domain;
  const resolvedDomain = domain
    ? interpolate(domain, properties, "domain")
    : undefined;
  if (resolvedDomain !== undefined && !validHostname(resolvedDomain))
    throw new ConfigError(
      `Domain '${resolvedDomain}' is not a hostname.`,
      "invalid_domain",
      { domain: resolvedDomain, path: "domain" },
      "Use a hostname such as app.test or ${subdomain}.app.test; schemes, ports, paths, wildcards and lists are not allowed.",
    );
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
              interpolate(value, properties, `env.${key}`),
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
    ...(resolvedDomain !== undefined ? { domain: resolvedDomain } : {}),
    ...(lane?.proxy ? { proxy: lane.proxy } : {}),
    ...(config.hooks
      ? { hooks: resolveHooks(config.hooks, properties, undefined) }
      : {}),
    ...(config.hookTimeout ? { hookTimeout: config.hookTimeout } : {}),
    ...(config.installTimeout ? { installTimeout: config.installTimeout } : {}),
    ...(envFile ? { envFile } : {}),
  };
}

/** Resolves a config path against its Target root. Deployed Targets (live and Previews) own their storage,
 * so a path that lands outside the root is rejected as ConfigError `path_outside_target`; the developer's local
 * working copy keeps whatever path they wrote.
 */
function targetPath(
  target: TargetKind,
  root: string,
  value: string,
  context: { readonly component?: string; readonly field: "path" | "envFile" },
): string {
  const path = resolve(root, value),
    inside = relative(root, path);
  if (
    target !== "local" &&
    (inside === "" || inside.startsWith("..") || isAbsolute(inside))
  )
    throw new ConfigError(
      `${context.component ? `Component '${context.component}' ` : "Lane "}${context.field} '${value}' resolves outside the Target's ${context.field === "path" ? "persistent storage" : "workspace"} (${root}).`,
      "path_outside_target",
      { ...context, path, root },
      `Give ${context.field} a relative path inside the Target; rigd only creates, protects, and destroys files it owns.`,
    );
  return path;
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
      reserve(name, component.port);
      // A Postgres URL is a connection string; libpq fills in the OS user the cluster trusts.
      if ("uses" in component && component.uses === "postgres")
        properties[`${name}.url`] =
          `postgres://127.0.0.1:${properties[`${name}.port`]}/postgres`;
      if ("uses" in component && component.uses === "convex") {
        // The site port's port + 1 fallback is the runtime's preference when it
        // requests ports; the resolver records only what was configured or assigned.
        const sitePort = reserve(`${name}.site`, component.sitePort);
        Object.assign(properties, {
          [`${name}.sitePort`]: sitePort,
          [`${name}.siteUrl`]: `http://127.0.0.1:${sitePort}`,
          [`${name}.stateDir`]: convexStateDir(input, name),
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
      const path = targetPath(
        input.target,
        persistentRoot(input),
        interpolate(
          component.path ?? join(input.dataRoot, "sqlite", `${name}.sqlite`),
          properties,
          `components.${name}.path`,
        ),
        { component: name, field: "path" },
      );
      properties[`${name}.path`] = path;
      preparedComponents.push({ name, uses: "sqlite", path });
    }
  return { properties, preparedComponents };
}

/** Relative persistent paths live in the working copy for local and in Target storage for deployed Targets, whose checkouts are replaced on every deploy. */
function persistentRoot(
  input: Pick<ResolveTargetPlanInput, "target" | "workspacePath" | "dataRoot">,
): string {
  return input.target === "local" ? input.workspacePath : input.dataRoot;
}
/** Convex reads `<cwd>/.convex/local/default`; deployed Targets keep the state in Target storage and link the checkout to it at prepare time. */
function convexStateDir(
  input: Pick<ResolveTargetPlanInput, "target" | "workspacePath" | "dataRoot">,
  name: string,
): string {
  return input.target === "local"
    ? join(input.workspacePath, ".convex/local/default")
    : join(input.dataRoot, "convex", name);
}
/** Resolves one Component's complete runtime policy from already resolved Target properties. */
function resolvePlanComponent({
  name,
  component,
  shared,
  lane,
  target,
  workspacePath,
  properties,
}: {
  name: string;
  component: Component;
  shared: Component;
  lane: Lane | undefined;
  target: TargetKind;
  workspacePath: string;
  properties: Properties;
}): PlanComponent {
  const env = Object.fromEntries(
    Object.entries({
      ...lane?.env,
      ...("env" in shared ? shared.env : {}),
      ...lane?.components?.[name]?.env,
    }).map(([key, value]) => [
      key,
      interpolate(value, properties, `components.${name}.env.${key}`),
    ]),
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
      ? { hooks: resolveHooks(component.hooks, properties, name) }
      : {}),
    ...("hookTimeout" in component && component.hookTimeout
      ? { hookTimeout: component.hookTimeout }
      : {}),
    ...(envFile
      ? {
          envFile: targetPath(
            target,
            workspacePath,
            interpolate(envFile, properties, `components.${name}.envFile`),
            { component: name, field: "envFile" },
          ),
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
        interpolate(
          component.entrypoint,
          properties,
          `components.${name}.entrypoint`,
        ),
      ),
      ...(component.build
        ? {
            build: interpolateShell(
              component.build,
              properties,
              `components.${name}.build`,
            ),
          }
        : {}),
      ...(component.buildTimeout
        ? { buildTimeout: component.buildTimeout }
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
    command ??= `sh -c 'test -f "$1/PG_VERSION" || initdb -E UTF8 -A trust --no-locale -D "$1" || exit; exec postgres -D "$1" -h 127.0.0.1 -p "$2"' -- ${shellArg(String(properties[`${name}.dataDir`]))} ${port}`;
    health ??= `pg_isready -h 127.0.0.1 -p ${port}`;
  }
  const resolvedCommand = interpolateShell(
    command!,
    properties,
    `components.${name}.command`,
  );
  if (!localhostCommand(resolvedCommand))
    throw new ConfigError(
      "Resolved command binds outside localhost.",
      "invalid_binding",
      { component: name },
    );
  const resolvedHealth = health
    ? interpolateShell(health, properties, `components.${name}.health`)
    : undefined;
  if (resolvedHealth !== undefined && !localhostHealth(resolvedHealth))
    throw new ConfigError(
      "Resolved health check addresses a host outside localhost.",
      "invalid_binding",
      { component: name, field: "health" },
    );
  return {
    ...common,
    kind: "managed" as const,
    port,
    command: resolvedCommand,
    readyTimeout: component.readyTimeout ?? (plugin ? 60 : 30),
    ...(resolvedHealth !== undefined ? { health: resolvedHealth } : {}),
    ...(plugin === "convex"
      ? { sitePort: Number(properties[`${name}.sitePort`]) }
      : {}),
  };
}
