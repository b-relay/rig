import { ConfigError } from "./errors";
import { referenceResolver } from "./references";
import {
  roleHostname,
  roleServiceDomains,
  serviceDomainPort,
  type ServiceDomainSetting,
} from "./hostnames";
import {
  healthcheckInForce,
  isHealthUrl,
  type HealthcheckSettings,
} from "./healthcheck";
import { PROXY_UPSTREAM, type ProjectConfig } from "./project-fields";
import { isRecord, type Fields } from "./record";
import { patchSettings } from "./target-patch";
import { TARGET_ROLES, targetOn, type TargetRole } from "./target-roles";
import { RENAMED_RULE } from "./validation-messages";

// The rules of rig.yaml that span fields: dependency and reference graphs, pinned ports, routes and Service domains, judged
// on the base settings and on each role's patch applied.

/** One problem a cross-field rule found, at its field path. */
export interface RuleIssue {
  path: PropertyKey[];
  message: string;
  rule?: typeof RENAMED_RULE;
}
type Report = (
  path: PropertyKey[],
  message: string,
  rule?: typeof RENAMED_RULE,
) => void;
/** One Service as the cross-field rules read it. */
type GraphService = Fields & {
  command?: string;
  build?: string;
  healthcheck?: HealthcheckSettings;
  depends_on?: readonly string[];
  ports?: Readonly<Record<string, number | "auto">>;
  domain?: ServiceDomainSetting;
  environment?: Readonly<Record<string, string>>;
  env_file?: string | readonly string[];
};
/** One settings graph as the cross-field rules read it: the base settings, or the base with one role's patch applied. */
type GraphSettings = {
  domain?: string;
  build?: string;
  environment?: Readonly<Record<string, string>>;
  env_file?: string | readonly string[];
  services?: Readonly<Record<string, GraphService>>;
  tools?: Readonly<Record<string, { bin?: string; build?: string }>>;
  jobs?: Readonly<
    Record<
      string,
      {
        command?: string;
        environment?: Readonly<Record<string, string>>;
        env_file?: string | readonly string[];
        backup?: { restore?: string };
      }
    >
  >;
  proxy?: Readonly<Record<string, string>>;
};
type GraphConfig = GraphSettings & {
  targets?: Partial<Record<TargetRole, GraphSettings | boolean>>;
};
/** Every problem of a Project that spans fields, in the order the schema reports them: names Services, Tools and jobs
 * share, then each settings graph (the base, then each role's patch applied) with its references, then the routes and
 * Service domains of the Targets that are on. A problem the graphs repeat is reported once, at the first place found. */
export function projectRuleIssues(project: ProjectConfig): RuleIssue[] {
  const config = project as GraphConfig;
  const issues: RuleIssue[] = [];
  const services = Object.keys(config.services ?? {}),
    tools = Object.keys(config.tools ?? {}),
    jobs = Object.keys(config.jobs ?? {});
  if (!services.length && !tools.length && !jobs.length)
    issues.push({
      path: ["services"],
      message: "A Project needs at least one Service, Tool or job.",
    });
  for (const name of services)
    if (tools.includes(name))
      issues.push({
        path: ["tools", name],
        message: "A Tool cannot share its name with a Service.",
      });
  // Log lines, status and rig logs --service name a job, a Service and a Tool alike, so the names must differ.
  for (const name of jobs)
    if (services.includes(name) || tools.includes(name))
      issues.push({
        path: ["jobs", name],
        message: `A job cannot share its name with a ${services.includes(name) ? "Service" : "Tool"}.`,
      });
  const reported = new Set<string>();
  const report: Report = (path, message, rule) => {
    if (reported.has(message)) return;
    reported.add(message);
    issues.push({ path, message, ...(rule ? { rule } : {}) });
  };
  // The unpatched graph is checked first so a base mistake is reported at its own path, once.
  validateGraph(config, [], report);
  for (const role of TARGET_ROLES) {
    const patch = config.targets?.[role];
    // A switch without settings patches nothing: its graph is the base graph, already checked.
    if (!isRecord(patch)) continue;
    const at = ["targets", role];
    for (const kind of ["services", "tools"] as const)
      for (const key of Object.keys(patch[kind] ?? {}))
        if (!Object.hasOwn(config[kind] ?? {}, key))
          report(
            [...at, kind, key],
            `A Target patch cannot add the ${kind === "services" ? "Service" : "Tool"} '${key}'; declare it at the top level.`,
          );
    if (role === "preview")
      for (const [key, entry] of Object.entries(patch.services ?? {}))
        for (const [port, value] of Object.entries(entry.ports ?? {}))
          if (value !== "auto")
            report(
              [...at, "services", key, "ports", port],
              "Previews always use chosen ports; only the working and stable Targets can pin one.",
            );
    validateGraph(patchSettings(config, role) as GraphSettings, at, report);
  }
  // A Target with a hostname needs to know which Service serves it: a proxy, or the one Service that has one port.
  for (const role of TARGET_ROLES) {
    if (!targetOn(config, role)) continue;
    const patch = config.targets?.[role];
    const patched = isRecord(patch) && patch.domain !== undefined;
    // The working Target has a hostname only when its own patch sets one.
    if (role === "working" ? !patched : config.domain === undefined && !patched)
      continue;
    const problem = missingProxy(
      patchSettings(config, role) as GraphSettings,
      role,
      patched,
    );
    if (problem)
      report(patched ? ["targets", role, "domain"] : ["domain"], problem);
  }
  // Each Service domain a Target that is on serves must reach one port, and every hostname of one Target is its own site.
  for (const role of TARGET_ROLES)
    if (targetOn(config, role)) checkServiceDomains(config, role, report);
  return issues;
}
/** Checks the Service domains a Target of `role` serves: each must name a port it can reach with the ports this role gives
 * the Service (a domain the role does not serve is not checked), and no two settings may give the Target one hostname (the
 * Project domain included). Patterns are compared as written, `${rig.target}` included, so the check holds for every Target
 * of the role; planning compares the resolved hostnames again. */
function checkServiceDomains(
  config: GraphConfig,
  role: TargetRole,
  report: Report,
): void {
  const patch = config.targets?.[role];
  const own = isRecord(patch) ? patch : {};
  const services = (patchSettings(config, role) as GraphSettings).services;
  const domain = roleHostname(config.domain, own.domain, role);
  const seen = new Map<string, string>();
  if (domain)
    seen.set(
      domain.pattern.toLowerCase(),
      domain.patched ? `targets.${role}.domain` : "domain",
    );
  for (const entry of roleServiceDomains(
    config.services,
    own.services,
    services,
    role,
  )) {
    // Only a domain this role serves needs a port it can reach, with the ports this role gives the Service.
    const reached = serviceDomainPort(
      entry.service,
      services?.[entry.service]?.domain ?? entry.pattern,
      services?.[entry.service]?.ports,
    );
    if ("problem" in reached) report(entry.path.split("."), reached.problem);
    const key = entry.pattern.toLowerCase();
    const first = seen.get(key);
    if (first === undefined) seen.set(key, entry.path);
    else
      report(
        entry.path.split("."),
        `${first} gives this Target the same hostname; each hostname of a Target must differ.`,
      );
  }
}
/** The Service and port a proxy value names in one settings graph: a Service name or `${services.<name>.port}` means that
 * Service's only port. A value that names no declared port says why, in words that name the fix. */
export function proxyUpstream(
  value: string,
  services: Readonly<
    Record<string, { ports?: Readonly<Record<string, unknown>> }>
  >,
): { service: string; port: string } | { problem: string } {
  const match = PROXY_UPSTREAM.exec(value);
  if (!match) return { problem: `'${value}' names no Service or port` };
  const service = match[1] ?? match[2]!,
    named = match[3];
  if (!Object.hasOwn(services, service))
    return { problem: `'${service}' is not a declared Service` };
  const ports = Object.keys(services[service]!.ports ?? {});
  if (named !== undefined)
    return ports.includes(named)
      ? { service, port: named }
      : {
          problem: `'${service}.${named}' is not a declared Service port`,
        };
  if (ports.length === 1) return { service, port: ports[0]! };
  return {
    problem: ports.length
      ? `'${service}' has ${ports.length} ports (${ports.join(", ")}); name one, such as \${services.${service}.ports.${ports[0]}}`
      : `'${service}' declares no port to route to`,
  };
}
/** The proxy a Target with a hostname but no proxy gets: '/' to the one Service that declares ports, when it declares
 * exactly one. Undefined when no Service or several declare ports, or that Service declares several. */
export function defaultProxy(
  services: Readonly<
    Record<string, { ports?: Readonly<Record<string, unknown>> }>
  > = {},
): Record<string, string> | undefined {
  const serving = Object.entries(services).filter(
    ([, service]) => Object.keys(service.ports ?? {}).length > 0,
  );
  return serving.length === 1 &&
    Object.keys(serving[0]![1].ports ?? {}).length === 1
    ? { "/": serving[0]![0] }
    : undefined;
}
/** Why a Target of `role` that has a hostname has no route, naming the role and where to add the proxy; undefined when a
 * proxy, given or default, routes it. `patched` says the hostname comes from the role's own patch. */
function missingProxy(
  settings: GraphSettings,
  role: TargetRole,
  patched: boolean,
): string | undefined {
  if (settings.proxy || defaultProxy(settings.services)) return undefined;
  const hostname =
    role === "preview"
      ? patched
        ? "Previews have a hostname"
        : "Previews get a hostname from domain"
      : patched
        ? `The ${role} Target has a hostname`
        : "The stable Target serves domain";
  const serving = Object.entries(settings.services ?? {}).filter(
    ([, service]) => Object.keys(service.ports ?? {}).length > 0,
  );
  if (!serving.length)
    return `${hostname} but no Service has a port; declare one, such as ports: { http: auto }, or remove the domain.`;
  const [name, service] = serving[0]!;
  const where = `at the top level or under targets.${role}`;
  return serving.length > 1
    ? `${hostname} but several Services have ports; add proxy: { /: ${name} } ${where}.`
    : `${hostname} but '${name}' has several ports; add proxy: { /: \${services.${name}.ports.${Object.keys(service.ports!)[0]}} } ${where}.`;
}
/** Structural rules of one settings graph: dependency references and cycles, pinned ports, and proxy references. */
function validateGraph(
  settings: GraphSettings,
  at: readonly PropertyKey[],
  report: Report,
): void {
  const services = settings.services ?? {};
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key))
      return report(
        [...at, "services", key, "depends_on"],
        `Service dependencies contain a cycle through '${key}'.`,
      );
    if (done.has(key)) return;
    visiting.add(key);
    for (const dependency of services[key]?.depends_on ?? [])
      if (!Object.hasOwn(services, dependency))
        report(
          [...at, "services", key, "depends_on"],
          `Dependency '${dependency}' of Service '${key}' is not a declared Service.`,
        );
      else visit(dependency);
    visiting.delete(key);
    done.add(key);
  };
  for (const key of Object.keys(services)) visit(key);
  const pinned = new Map<number, string>();
  for (const [key, entry] of Object.entries(services))
    for (const [port, value] of Object.entries(entry.ports ?? {})) {
      if (value === "auto") continue;
      const owner = pinned.get(value);
      if (owner)
        report(
          [...at, "services", key, "ports", port],
          `Port ${value} is pinned by both ${owner} and ${key}.${port}.`,
        );
      else pinned.set(value, `${key}.${port}`);
    }
  // A healthcheck without test checks the declared ports; with none there is nothing to check.
  for (const [key, entry] of Object.entries(services))
    if (
      healthcheckInForce(entry.healthcheck) &&
      entry.healthcheck.test === undefined &&
      !Object.keys(entry.ports ?? {}).length
    )
      report(
        [...at, "services", key, "healthcheck"],
        `Service '${key}' declares no port, so its healthcheck needs a test, such as test: test -f /tmp/${key}.alive.`,
      );
  validateReferences(settings, at, report);
  if (!settings.proxy) return;
  if (!Object.hasOwn(settings.proxy, "/"))
    report([...at, "proxy"], "A proxy needs a '/' entry.");
  // '/api' and '/api/' are one path to the router, and '//' is no path at all.
  const paths = new Map<string, string>();
  for (const [prefix, reference] of Object.entries(settings.proxy)) {
    const path = prefix.replace(/\/+$/, "");
    const twin = paths.get(path);
    if (prefix !== "/" && path === "")
      report([...at, "proxy", prefix], `Proxy '${prefix}' names no path.`);
    else if (twin !== undefined)
      report(
        [...at, "proxy", prefix],
        `Proxy '${prefix}' and '${twin}' are the same path.`,
      );
    else paths.set(path, prefix);
    const upstream = proxyUpstream(reference, services);
    if ("problem" in upstream)
      report(
        [...at, "proxy", prefix],
        `Proxy '${prefix}': ${upstream.problem}.`,
      );
  }
}
/** Resolves every reference-bearing string against placeholder generated values, so a missing path, a collection,
 * a cycle, a reference into targets or rig.data outside a Service is reported when the document is read, not at the first deploy. */
function validateReferences(
  settings: GraphSettings,
  at: readonly PropertyKey[],
  report: Report,
): void {
  const references = referenceResolver(settings, {
    target: "target",
    workspace: "/workspace",
    host: "",
    url: "",
    data: () => "/data",
    port: () => 1,
  });
  // Each field with whether /bin/sh -c runs it, where a reference must also sit where Rig can keep its value literal.
  const fields: [string[], string | undefined, boolean][] = [
    [["build"], settings.build, true],
    ...Object.entries(settings.environment ?? {}).map(
      ([key, value]): [string[], string, boolean] => [
        ["environment", key],
        value,
        false,
      ],
    ),
    ...[settings.env_file ?? []]
      .flat()
      .map((value): [string[], string, boolean] => [
        ["env_file"],
        value,
        false,
      ]),
  ];
  for (const [name, service] of Object.entries(settings.services ?? {})) {
    const own = ["services", name];
    for (const field of ["command", "build"] as const)
      fields.push([[...own, field], service[field], true]);
    const test = service.healthcheck?.test;
    if (typeof test === "string")
      fields.push([[...own, "healthcheck", "test"], test, !isHealthUrl(test)]);
    else
      for (const [index, value] of (test ?? []).entries())
        if (index > 0)
          fields.push([
            [...own, "healthcheck", "test", String(index)],
            value,
            test![0] === "CMD-SHELL",
          ]);
    for (const [key, value] of Object.entries(service.environment ?? {}))
      fields.push([[...own, "environment", key], value, false]);
    for (const value of [service.env_file ?? []].flat())
      fields.push([[...own, "env_file"], value, false]);
  }
  for (const [name, tool] of Object.entries(settings.tools ?? {})) {
    fields.push([["tools", name, "bin"], tool.bin, false]);
    fields.push([["tools", name, "build"], tool.build, true]);
  }
  for (const [name, job] of Object.entries(settings.jobs ?? {})) {
    const own = ["jobs", name];
    fields.push([[...own, "command"], job.command, true]);
    fields.push([[...own, "backup", "restore"], job.backup?.restore, true]);
    for (const [key, value] of Object.entries(job.environment ?? {}))
      fields.push([[...own, "environment", key], value, false]);
    for (const value of [job.env_file ?? []].flat())
      fields.push([[...own, "env_file"], value, false]);
  }
  for (const [path, value, shell] of fields) {
    if (value === undefined) continue;
    try {
      if (shell) references.shell(value, path.join("."));
      else references.text(value, path.join("."));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      report(
        [...at, ...path],
        // Where a reference sits is fixed by writing the command another way, which the hint says.
        error.code === "unsafe_reference"
          ? `A reference sits ${String(error.context.place)}. ${error.hint}`
          : error.message,
        error.code === "renamed_reference" ? RENAMED_RULE : undefined,
      );
    }
  }
}
