import { join } from "node:path";
import { parse, stringify } from "yaml";
import { projectConfigSchema } from "../config/index";
import type { Review } from "./review";
import type {
  LegacyComponentConfig,
  LegacyLane,
  LegacyProjectConfig,
} from "./legacy-project";

/** A `rig.yaml` for the operator to review and commit. Rig writes it next to the conversion, never into a repository. */
export interface ProjectCandidate {
  yaml: string;
  /** `ready`: the new schema accepts it as written. `needs-editing`: it does not yet; `notes` say what is left. */
  status: "ready" | "needs-editing";
  /** What has no field in `rig.yaml` and needs the operator: env files, dependencies Rig no longer provides, references. */
  notes: string[];
}
const ROLES = {
  local: "working",
  live: "stable",
  deployments: "preview",
} as const;
type Tree = Record<string, unknown>;

/** Pure: the retired Project configuration, plus the reviewed hook decisions, as the closest `rig.yaml`. Nothing is guessed
 * silently: whatever has no equivalent is left out and named in `notes`. `envRoot` is only used to name where values of a
 * retired env file belong; no env file is read. */
export function projectCandidate(
  config: LegacyProjectConfig,
  review: Review,
  envRoot: string,
): ProjectCandidate {
  const notes: string[] = [],
    managed = new Set(
      Object.entries(config.components)
        .filter(
          ([, component]) =>
            "mode" in component && component.mode === "managed",
        )
        .map(([name]) => name),
    );
  const reference = (value: string, at: string) =>
    value.replace(/\$\{([^}]+)\}/g, (match, raw: string) => {
      const key = raw.trim(),
        port = /^(.+)\.port$/.exec(key)?.[1] ?? /^ports?\.(.+)$/.exec(key)?.[1],
        url = /^(.+)\.url$/.exec(key)?.[1];
      if (port && managed.has(port)) return `\${services.${port}.ports.http}`;
      if (url && managed.has(url))
        return `http://127.0.0.1:\${services.${url}.ports.http}`;
      if (key === "subdomain") return "${rig.target}";
      notes.push(`${at}: ${match} has no equivalent reference; rewrite it.`);
      return match;
    });
  const envValues = (values: Record<string, string> | undefined, at: string) =>
    values && Object.keys(values).length
      ? {
          env: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              key,
              reference(value, `${at}.env.${key}`),
            ]),
          ),
        }
      : {};
  const seconds = (value: number | undefined) =>
    value === undefined ? undefined : `${value}s`;
  const envFileNote = (scope: string[], role: string, at: string) =>
    notes.push(
      `${at}: env files are no longer read from a Commit. Put its values in ${join(envRoot, config.name, ...scope, `${role}.env`)} (mode 600); a key also set in env is now overridden by the file, where the retired runtime let env win.`,
    );
  const service = (
    name: string,
    fields: Partial<Extract<LegacyComponentConfig, { mode: "managed" }>>,
    at: string,
  ): Tree => ({
    ...(fields.command
      ? { run: reference(fields.command, `${at}.command`) }
      : {}),
    ...(fields.port !== undefined ? { ports: { http: fields.port } } : {}),
    ...(fields.health
      ? { ready: reference(fields.health, `${at}.health`) }
      : {}),
    ...(fields.readyTimeout !== undefined
      ? { ready_timeout: seconds(fields.readyTimeout) }
      : {}),
    ...(fields.dependsOn
      ? {
          depends_on: fields.dependsOn.filter((dependency) => {
            if (managed.has(dependency)) return true;
            notes.push(
              `${at}: the dependency on ${dependency} is dropped; it is not a Service any more.`,
            );
            return false;
          }),
        }
      : {}),
    ...envValues(fields.env, at),
    ...hookFields(name, fields, at),
  });
  const hookFields = (
    name: string,
    fields: {
      hooks?: Record<string, string | undefined>;
      hookTimeout?: number;
    },
    at: string,
  ): Tree => {
    let build: Tree = {};
    for (const [hook, command] of Object.entries(fields.hooks ?? {})) {
      if (command === undefined) continue;
      const subject = `${config.name}/${name}/${hook}`,
        decision = review.hooks[subject];
      if (!decision)
        notes.push(`${at}: the ${hook} hook has no reviewed decision.`);
      else if (decision.as === "replaced")
        notes.push(`${at}: the ${hook} hook is replaced by: ${decision.by}`);
      else
        build = {
          build: reference(command, `${at}.hooks.${hook}`),
          build_timeout: seconds(
            fields.hookTimeout ?? config.hookTimeout ?? 120,
          ),
        };
    }
    return build;
  };
  const tool = (
    fields: Partial<Extract<LegacyComponentConfig, { mode: "installed" }>>,
    at: string,
  ): Tree => ({
    ...(fields.build ? { build: reference(fields.build, `${at}.build`) } : {}),
    ...(fields.buildTimeout !== undefined
      ? { build_timeout: seconds(fields.buildTimeout) }
      : {}),
    ...(fields.entrypoint ? { bin: fields.entrypoint } : {}),
  });

  const services: Tree = {},
    tools: Tree = {},
    toolKeys = new Map<string, string>();
  for (const [name, component] of Object.entries(config.components)) {
    const at = `components.${name}`;
    if ("uses" in component) {
      notes.push(
        component.uses === "postgres"
          ? `${at}: Rig no longer provides Postgres. Generate a Service with rig recipe generate postgres and point it at the existing data directory yourself; nothing is relocated.`
          : `${at}: Rig no longer provides ${component.uses}. Declare it as an ordinary Service, or keep its files under \${rig.data}; nothing is relocated.`,
      );
      continue;
    }
    if (component.envFile) envFileNote([name], "all", `${at}.envFile`);
    if (component.mode === "managed")
      services[name] = service(name, component, at);
    else {
      const key = component.installName ?? name;
      toolKeys.set(name, key);
      tools[key] = tool(component, at);
      for (const hook of Object.keys(component.hooks ?? {}))
        notes.push(`${at}: the ${hook} hook of a Tool has no equivalent.`);
    }
  }
  for (const hook of Object.keys(config.hooks ?? {})) {
    const decision = review.hooks[`${config.name}/@project/${hook}`];
    notes.push(
      decision?.as === "replaced"
        ? `hooks.${hook}: replaced by: ${decision.by}`
        : `hooks.${hook}: a Project hook has no equivalent in rig.yaml.`,
    );
  }
  if (config.installTimeout !== undefined)
    notes.push(
      `installTimeout: rig.yaml has no dependency-install budget; the default applies.`,
    );

  const targets: Tree = {};
  const lanes: [keyof typeof ROLES, LegacyLane | undefined][] = [
    ["local", config.local],
    ["live", config.live],
    ["deployments", config.deployments],
  ];
  let proxy: Tree | undefined, supervisor: string | undefined;
  for (const [laneName, lane] of lanes) {
    const role = ROLES[laneName],
      at = laneName,
      patch: Tree = {},
      patchedServices: Tree = {},
      patchedTools: Tree = {};
    const domain = lane?.domain ?? config.domain;
    if (domain !== undefined && role !== "stable")
      patch.domain = domain.replaceAll(
        "${subdomain}",
        role === "working" ? "local" : "${rig.target}",
      );
    if (lane?.envFile) envFileNote([], role, `${at}.envFile`);
    Object.assign(patch, envValues(lane?.env, at));
    for (const [name, fields] of Object.entries(lane?.components ?? {})) {
      const where = `${at}.components.${name}`;
      if (fields.envFile) envFileNote([name], role, `${where}.envFile`);
      if (managed.has(name))
        patchedServices[name] = service(name, fields, where);
      else if (toolKeys.has(name))
        patchedTools[toolKeys.get(name)!] = tool(fields, where);
      else
        notes.push(`${where}: overrides a dependency Rig no longer provides.`);
    }
    if (lane?.daemon?.keepAlive === false)
      for (const name of managed)
        patchedServices[name] = {
          ...(patchedServices[name] as Tree | undefined),
          restart: "no",
        };
    if (lane?.proxy) {
      const routes = {
        "/": `\${services.${lane.proxy.upstream}.ports.http}`,
      };
      if (role === "stable") proxy = routes;
      else patch.proxy = routes;
    }
    if (lane?.providers?.processSupervisor === "launchd") {
      if (role === "stable") supervisor = "launchd";
      else patch.supervisor = "launchd";
    }
    if (lane?.subdomain)
      notes.push(`${at}.subdomain: Target names replace subdomain templates.`);
    if (Object.keys(patchedServices).length) patch.services = patchedServices;
    if (Object.keys(patchedTools).length) patch.tools = patchedTools;
    // Stable is the unpatched document in the new format, so its lane folds into a `stable` patch only for overrides.
    if (Object.keys(patch).length) targets[role] = patch;
  }
  const document: Tree = {
    name: config.name,
    ...(config.description ? { description: config.description } : {}),
    ...(config.live?.deployBranch
      ? { production_branch: config.live.deployBranch }
      : {}),
    ...((config.live?.domain ?? config.domain)
      ? {
          domain: (config.live?.domain ?? config.domain)!.replaceAll(
            "${subdomain}",
            "live",
          ),
        }
      : {}),
    ...(supervisor ? { supervisor } : {}),
    ...(Object.keys(services).length ? { services } : {}),
    ...(Object.keys(tools).length ? { tools } : {}),
    ...(proxy ? { proxy } : {}),
    ...(Object.keys(targets).length ? { targets } : {}),
  };
  // Checked as the text the operator will commit, not as the object it was made from.
  const yaml = stringify(document),
    checked = projectConfigSchema.safeParse(parse(yaml));
  if (!checked.success)
    for (const issue of checked.error.issues.slice(0, 5))
      notes.push(`${issue.path.join(".") || "rig.yaml"}: ${issue.message}`);
  return {
    yaml,
    status: checked.success ? "ready" : "needs-editing",
    notes,
  };
}
