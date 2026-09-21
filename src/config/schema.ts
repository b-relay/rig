import { z } from "zod";
import { ConfigError } from "./errors.js";
import { referenceResolver } from "./references.js";
const text = z.string().min(1);
const name = text
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    "must start with a letter or digit and contain only letters, digits, '_' or '-'",
  )
  .describe("Stable registered Project name.");
const entryName = text
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "must start with a lowercase letter or digit and contain only lowercase letters, digits or '-'",
  )
  .describe(
    "Service or Tool name used in references, dependencies and output.",
  );
/** Validates explicit bind flags, descending into quoted sub-commands such as `sh -c "..."`;
 * ordinary command URL arguments may reference remote services. */
export function localhostCommand(value: string): boolean {
  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const quoted = /^(["']).*\1$/.test(tokens[i]!) && tokens[i]!.length > 1;
    const token = tokens[i]!.replace(/^['"]|['"]$/g, "");
    if (quoted && /\s/.test(token) && !localhostCommand(token)) return false;
    const match =
      /^--(?:host|hostname|bind|bind-host|listen|listen-host|addr|address)(?:=(.+))?$/.exec(
        token,
      );
    if (match) {
      const host = (match[1] ?? tokens[++i] ?? "")
        .replace(/^['"]|['"]$/g, "")
        .replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1"].includes(host)) return false;
    }
  }
  return !/(?:^|[\s='"])(?:0\.0\.0\.0|\[?::\]?)(?=[:\s'"]|$)/.test(value);
}
/** Env keys servers commonly read for their bind address; a wildcard there opens the process to the network as surely as a flag. */
const BIND_KEY =
  /^(?:HOST|HOSTNAME|BIND|BIND_ADDR|BIND_ADDRESS|BIND_HOST|LISTEN|LISTEN_ADDR|LISTEN_ADDRESS|LISTEN_HOST|ADDR|ADDRESS)$/;
const WILDCARD_ADDRESS = /^(?:0\.0\.0\.0|\[::\]|::)(?::\d+)?$/;
type ReferenceScope = "project" | "service";
/** The one owner of the reference list an editor shows on hover; the long form is "References" in docs/rig-guide.md.
 * ${rig.data} is one Service's directory, so only a Service's own fields offer it. */
const referencesIn = (scope: ReferenceScope) =>
  `References: \${env.NAME}, \${services.<service>.ports.<port>}, a scalar setting by its path such as \${services.api.ready_timeout}, \${rig.target}, \${rig.workspace}, \${rig.host}, \${rig.url}${scope === "service" ? ", ${rig.data}" : ""}. $\${VAR} writes a literal \${VAR}.`;
const command = text
  .refine(
    (value) => localhostCommand(value.replace(/\$\{[^}]+\}/g, "1234")),
    "Explicit network bindings must use 127.0.0.1 or localhost.",
  )
  .describe(
    "Shell command run with /bin/sh -c; explicit bindings must be localhost only. Interpolated values with spaces or shell characters are single-quoted unless the placeholder is already quoted.",
  );
/** A health value is an HTTP probe when it starts with an http(s) scheme in any letter case; anything else runs as a shell command. */
export function isHealthUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
/** A health URL must parse as a whole, carry no userinfo, and address 127.0.0.1 or localhost; a shell health command follows the command rule. */
export function localhostHealth(value: string): boolean {
  if (!isHealthUrl(value)) return localhostCommand(value);
  try {
    const url = new URL(value);
    return (
      url.username === "" &&
      url.password === "" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
const health = text
  .refine(
    (value) => localhostHealth(value.replace(/\$\{[^}]+\}/g, "1234")),
    "Health checks must address 127.0.0.1 or localhost.",
  )
  .describe(
    "Local HTTP URL or shell command used to check readiness; interpolated values are shell-quoted like command.",
  );
/** A hostname Caddy will serve as one site: labels of letters, digits and '-', joined by dots.
 * Schemes, ports, paths, wildcards and comma lists would be rejected by Caddy at deploy time
 * or, for a catch-all, would take every request on the Host. */
export function validHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    /^[a-zA-Z0-9-]{1,63}(\.[a-zA-Z0-9-]{1,63})*$/.test(value)
  );
}
/** The one hostname substitution: the actual Target name, which is always a single valid label. */
const TARGET_REFERENCE = "${rig.target}";
const DOMAIN_REFERENCE = `${TARGET_REFERENCE} is the only reference a hostname may contain.`;
const domain = text
  .refine(
    (value) =>
      !value.replaceAll(TARGET_REFERENCE, "").includes("${") &&
      validHostname(value.replaceAll(TARGET_REFERENCE, "target")),
    "must be a hostname such as app.test or ${rig.target}.app.test; schemes, ports, paths, wildcards, lists and other references are not allowed",
  )
  .describe(`Single hostname. ${DOMAIN_REFERENCE}`);
const DURATION_UNITS = { s: 1, m: 60, h: 3600 } as const;
/** Whole seconds of a validated duration such as 30s, 10m or 1h. */
export function durationSeconds(value: string): number {
  const match = /^([1-9]\d{0,5})(s|m|h)$/.exec(value);
  return match
    ? Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS]
    : Number.NaN;
}
/** One day is the most a timer can be asked to hold without overflowing. */
const duration = text.refine((value) => {
  const seconds = durationSeconds(value);
  return seconds >= 1 && seconds <= 86400;
}, "must be a positive duration of at most one day, such as 30s, 10m or 1h");
const supervisor = z
  .enum(["rigd", "launchd"])
  .describe(
    "Process supervisor: rigd (child processes owned by the daemon) or launchd (per-Service launchd agents). The Project sets it for all its Services. It can also be set per Target role under targets.<role>.supervisor. A Service value that differs from its Target's is refused.",
  );
const envName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "must be an environment variable name: letters, digits and '_', not starting with a digit",
  );
/** Public inline environment; only wildcard addresses under bind-style keys are rejected, since HOST may also name a public hostname. */
const environment = (scope: ReferenceScope) =>
  z
    .unknown()
    // The record parser drops a __proto__ key without a word, so it is refused before it gets there.
    .refine(
      (env) =>
        typeof env !== "object" ||
        env === null ||
        !Object.hasOwn(env, "__proto__"),
      "__proto__ is not an environment variable name.",
    )
    .pipe(
      z.record(
        envName,
        z.string().describe(`Public value. ${referencesIn(scope)}`),
      ),
    )
    .superRefine((env, ctx) => {
      for (const [key, value] of Object.entries(env))
        if (BIND_KEY.test(key) && WILDCARD_ADDRESS.test(value.trim()))
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} must bind to 127.0.0.1 or localhost, not a wildcard address.`,
          });
    });
const env = (scope: ReferenceScope) =>
  environment(scope).describe(
    "Public environment values passed to the process; never put secrets here. Values may use ${...} references. Bind-style keys such as HOST or BIND_ADDR may not use a wildcard address.",
  );
const envFile = (scope: ReferenceScope) =>
  z
    .union([text, z.array(text).min(1)])
    .describe(
      `Environment file path, or an ordered list of paths where later files win. Listed files are required and hold plain KEY=value data; their contents never take part in \${...} references. Relative paths resolve against the workspace; ~ is the operator home. The path itself may use references. ${referencesIn(scope)}`,
    );
const BUILD_RULE =
  "run with /bin/sh -c in the workspace during preparation, never as a start hook; explicit bindings must be localhost only.";
/** A shared or Tool build runs with Project inputs only. */
const PROJECT_BUILD_REFERENCES = `${referencesIn("project")} A Service's env is not available here.`;
const build = command.describe(
  `Shell build command ${BUILD_RULE} ${PROJECT_BUILD_REFERENCES}`,
);
const buildTimeout = duration.describe(
  "Build duration budget such as 10m; a build past it is terminated and recorded as failed, never as completed.",
);
const portName = text
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "must start with a lowercase letter or digit and contain only lowercase letters, digits or '-'",
  )
  .describe("Port name used in ${services.<service>.ports.<port>} references.");
const ports = z
  .record(
    portName,
    z.union([z.literal("auto"), z.number().int().min(1).max(65535)]),
  )
  .describe(
    "Named local TCP ports: auto lets Rig choose and keep a free port, a number from 1 to 65535 pins it. Previews always use chosen ports.",
  );
const restart = z
  .enum(["always", "on-failure", "no"])
  .describe(
    "Automatic restart after a known exit: always (default), on-failure, or no. An explicit up or restart starts the Service under every policy.",
  );
const serviceFields = {
  run: command.describe(
    `Foreground shell command run with /bin/sh -c; explicit bindings must be localhost only. Referenced values with spaces or shell characters are single-quoted unless the reference is already quoted. ${referencesIn("service")}`,
  ),
  build: command
    .describe(
      `Shell build command of this Service, ${BUILD_RULE} ${referencesIn("service")}`,
    )
    .optional(),
  build_timeout: buildTimeout.optional(),
  ports: ports.optional(),
  ready: health
    .describe(
      `Local HTTP URL or shell command used to check readiness; referenced values in a shell command are quoted as in run. ${referencesIn("service")}`,
    )
    .optional(),
  ready_timeout: duration
    .optional()
    .describe("Startup readiness budget such as 30s (the default)."),
  depends_on: z
    .array(entryName)
    .optional()
    .describe(
      "Services that must be running and ready before this one starts; a later dependency failure does not restart this Service.",
    ),
  restart: restart.optional(),
  supervisor: supervisor.optional(),
  env: env("service").optional(),
  env_file: envFile("service").optional(),
};
const service = z.strictObject(serviceFields);
const toolFields = {
  build: build.optional(),
  build_timeout: buildTimeout.optional(),
  bin: text.describe(
    `Executable path relative to the workspace; published under the Tool name for the Stable Target and <tool>-<target> elsewhere. ${referencesIn("project")}`,
  ),
};
const tool = z.strictObject(toolFields);
const proxy = z
  .record(
    z
      .string()
      .regex(
        /^\/[A-Za-z0-9._~/-]*$/,
        "must be a path prefix starting with '/' without wildcards or references",
      ),
    z
      .string()
      .regex(
        /^\$\{services\.[a-z0-9][a-z0-9-]*\.ports\.[a-z0-9][a-z0-9-]*\}$/,
        "must be one declared port reference such as ${services.web.ports.http}",
      )
      .describe(
        "Upstream of this prefix: exactly one ${services.<service>.ports.<port>} reference to a declared port, such as ${services.web.ports.http}. No other reference or text is allowed.",
      ),
  )
  .describe(
    "Path prefix to declared port reference. Prefixes match at a slash boundary, longest first, and the upstream path is unchanged; '/' is required.",
  );
/** Settings every role may patch. Maps merge per key; lists and scalars replace. */
const patchFields = {
  domain: domain
    .optional()
    .describe(
      `Hostname for this role's Targets, such as \${rig.target}.preview.app.test. ${DOMAIN_REFERENCE}`,
    ),
  supervisor: supervisor.optional(),
  build: build.optional(),
  build_timeout: buildTimeout.optional(),
  env: env("project").optional(),
  env_file: envFile("project").optional(),
  proxy: proxy.optional(),
  services: z
    .record(entryName, z.strictObject(serviceFields).partial())
    .optional()
    .describe(
      "Setting overrides keyed by an existing Service name; a patch cannot add or remove Services.",
    ),
  tools: z
    .record(entryName, z.strictObject(toolFields).partial())
    .optional()
    .describe(
      "Setting overrides keyed by an existing Tool name; a patch cannot add or remove Tools.",
    ),
};
export const PREVIEW_SELECTOR = "preview";
/** Generated Preview names end in a dash and eight hex digits of the Branch hash. */
const GENERATED_PREVIEW_NAME = /-[0-9a-f]{8}$/;
const targetName = text
  .max(63)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    "must start with a letter or digit and contain only letters, digits, '_' or '-'",
  )
  .refine(
    (value) => value !== PREVIEW_SELECTOR,
    "cannot be 'preview', which always selects Previews",
  )
  .refine(
    (value) => value !== "help",
    "cannot be 'help', which every command reads as a request for help",
  )
  .refine(
    (value) => !GENERATED_PREVIEW_NAME.test(value),
    "cannot end like a generated Preview name (a dash and eight hex digits)",
  );
const targets = z.strictObject({
  working: z
    .strictObject({
      name: targetName
        .optional()
        .describe(
          "Name that selects and displays the Working copy Target (default local). Renaming keeps its identity and stored data.",
        ),
      ...patchFields,
    })
    .optional()
    .describe("Working copy Target name and settings patch."),
  stable: z
    .strictObject({
      name: targetName
        .optional()
        .describe(
          "Name that selects and displays the Stable Target (default live). Renaming keeps its identity and stored data.",
        ),
      ...patchFields,
    })
    .optional()
    .describe("Stable Target name and settings patch."),
  preview: z
    .strictObject(patchFields)
    .optional()
    .describe(
      "Settings patch for every generated Preview; Preview names come from their Branch.",
    ),
});
export const TARGET_ROLES = ["working", "stable", "preview"] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];
export const DEFAULT_TARGET_NAMES = {
  working: "local",
  stable: "live",
} as const;
type Fields = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Settings patch rule: maps merge per key, lists and scalars replace. */
function mergeSettings(base: Fields, patch: Fields): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch))
    merged[key] =
      isRecord(merged[key]) && isRecord(value)
        ? mergeSettings(merged[key], value)
        : value;
  return merged;
}
export const projectConfigSchema = z
  .strictObject({
    name,
    description: z.string().optional().describe("Project description."),
    production_branch: text
      .optional()
      .describe(
        "Branch whose pushes deploy the Stable Target; defaults to the Host deploy.production_branch, then main.",
      ),
    domain: domain
      .optional()
      .describe(
        `Stable Target hostname. Previews default to <preview-name>.<domain>; the Working copy has no hostname unless its patch sets one. ${DOMAIN_REFERENCE}`,
      ),
    supervisor: supervisor.optional(),
    build: build
      .optional()
      .describe(
        `Shared shell build command, run once in the workspace before any Service or Tool build. ${PROJECT_BUILD_REFERENCES}`,
      ),
    build_timeout: buildTimeout
      .optional()
      .describe(
        "Duration budget for the shared build and the default for Service and Tool builds (default 10m).",
      ),
    env: env("project").optional(),
    env_file: envFile("project").optional(),
    services: z
      .record(entryName, service)
      .optional()
      .describe("Long-running Services keyed by name."),
    tools: z
      .record(entryName, tool)
      .optional()
      .describe("Installed command-line Tools keyed by name."),
    proxy: proxy.optional(),
    targets: targets
      .optional()
      .describe(
        "Role-keyed Target names and settings patches: working, stable and the preview template.",
      ),
  })
  .superRefine((config, ctx) => {
    const services = Object.keys(config.services ?? {}),
      tools = Object.keys(config.tools ?? {});
    if (!services.length && !tools.length)
      ctx.addIssue({
        code: "custom",
        path: ["services"],
        message: "A Project needs at least one Service or Tool.",
      });
    for (const name of services)
      if (tools.includes(name))
        ctx.addIssue({
          code: "custom",
          path: ["tools", name],
          message: "A Tool cannot share its name with a Service.",
        });
    const names = targetNames(config);
    if (names.working === names.stable)
      ctx.addIssue({
        code: "custom",
        path: [
          "targets",
          config.targets?.stable?.name ? "stable" : "working",
          "name",
        ],
        message: `The Working copy and Stable Target cannot both be named '${names.working}'.`,
      });
    const reported = new Set<string>();
    const report = (path: PropertyKey[], message: string) => {
      if (reported.has(message)) return;
      reported.add(message);
      ctx.addIssue({ code: "custom", path, message });
    };
    // The unpatched graph is checked first so a base mistake is reported at its own path, once.
    validateGraph(config, [], report);
    for (const role of TARGET_ROLES) {
      const patch = config.targets?.[role];
      if (!patch) continue;
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
                "Previews always use chosen ports; only the Working copy and Stable Target can pin one.",
              );
      validateGraph(patchedSettings(config, role), at, report);
    }
  });
type ParsedProject = z.infer<typeof projectConfigSchema>;
/** Project settings with one role's patch applied; Target name metadata never merges into them. */
export type ProjectSettings = Omit<ParsedProject, "targets">;
export function patchedSettings(
  config: ParsedProject,
  role: TargetRole,
): ProjectSettings {
  const { targets, ...base } = config;
  const patch: Record<string, unknown> = { ...targets?.[role] };
  delete patch.name;
  // A patch naming an unknown entry is reported by validation; merging would otherwise invent a partial entry.
  for (const kind of ["services", "tools"] as const)
    if (isRecord(patch[kind]))
      patch[kind] = Object.fromEntries(
        Object.entries(patch[kind]).filter(([key]) =>
          Object.hasOwn(base[kind] ?? {}, key),
        ),
      );
  return mergeSettings(base, patch) as ProjectSettings;
}
/** The names that select and display the Working copy and Stable Target. */
export function targetNames(
  config: Pick<ParsedProject, "targets">,
): Record<"working" | "stable", string> {
  return {
    working: config.targets?.working?.name ?? DEFAULT_TARGET_NAMES.working,
    stable: config.targets?.stable?.name ?? DEFAULT_TARGET_NAMES.stable,
  };
}
const PORT_REFERENCE = /^\$\{services\.([^.}]+)\.ports\.([^.}]+)\}$/;
/** The Service and port a proxy value names. */
export function proxyUpstream(
  reference: string,
): { service: string; port: string } | undefined {
  const match = PORT_REFERENCE.exec(reference);
  return match ? { service: match[1]!, port: match[2]! } : undefined;
}
/** Structural rules of one settings graph: dependency references and cycles, pinned ports, and proxy references. */
function validateGraph(
  settings: ProjectSettings,
  at: readonly PropertyKey[],
  report: (path: PropertyKey[], message: string) => void,
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
    const upstream = proxyUpstream(reference);
    if (
      upstream &&
      !Object.hasOwn(services[upstream.service]?.ports ?? {}, upstream.port)
    )
      report(
        [...at, "proxy", prefix],
        `Proxy '${prefix}' references '${upstream.service}.${upstream.port}', which is not a declared Service port.`,
      );
  }
}
/** Resolves every reference-bearing string against placeholder generated values, so a missing path, a collection,
 * a cycle, a reference into targets or rig.data outside a Service is reported when the document is read, not at the first deploy. */
function validateReferences(
  settings: ProjectSettings,
  at: readonly PropertyKey[],
  report: (path: PropertyKey[], message: string) => void,
): void {
  const references = referenceResolver(settings, {
    target: "target",
    workspace: "/workspace",
    host: "",
    url: "",
    data: () => "/data",
    port: () => 1,
  });
  const fields: [string[], string | undefined][] = [
    [["build"], settings.build],
    ...Object.entries(settings.env ?? {}).map(
      ([key, value]): [string[], string] => [["env", key], value],
    ),
    ...[settings.env_file ?? []]
      .flat()
      .map((value): [string[], string] => [["env_file"], value]),
  ];
  for (const [name, service] of Object.entries(settings.services ?? {})) {
    const own = ["services", name];
    for (const field of ["run", "build", "ready"] as const)
      fields.push([[...own, field], service[field]]);
    for (const [key, value] of Object.entries(service.env ?? {}))
      fields.push([[...own, "env", key], value]);
    for (const value of [service.env_file ?? []].flat())
      fields.push([[...own, "env_file"], value]);
  }
  for (const [name, tool] of Object.entries(settings.tools ?? {}))
    for (const field of ["bin", "build"] as const)
      fields.push([["tools", name, field], tool[field]]);
  for (const [path, value] of fields) {
    if (value === undefined) continue;
    try {
      references.text(value, path.join("."));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      report([...at, ...path], error.message);
    }
  }
}
const PATCH_IDENTITY_KEYS: Readonly<Record<string, string>> = {
  production_branch:
    "The Production branch is Project-wide; set production_branch at the top level.",
  description: "The Project description is not a Target setting.",
  targets: "A Target patch cannot contain targets.",
  role: "A Target's role is its fixed key (working, stable or preview) and cannot change.",
};
/** Refusals that need their own guidance, checked before the schema so they are not reported as generic unknown keys. */
function refuseUnsupportedShapes(value: unknown): void {
  if (!isRecord(value)) return;
  if (!isRecord(value.targets)) return;
  const issues: { path: string[]; message: string }[] = [];
  for (const [role, patch] of Object.entries(value.targets)) {
    if (!isRecord(patch)) continue;
    for (const [key, message] of Object.entries(PATCH_IDENTITY_KEYS))
      if (Object.hasOwn(patch, key))
        issues.push({ path: ["targets", role, key], message });
    if (role === "preview" && Object.hasOwn(patch, "name"))
      issues.push({
        path: ["targets", role, "name"],
        message:
          "Preview names are generated from their Branch; only working and stable take a name.",
      });
    for (const kind of ["services", "tools"])
      if (isRecord(patch[kind]))
        for (const [key, entry] of Object.entries(patch[kind]))
          if (entry === null)
            issues.push({
              path: ["targets", role, kind, key],
              message:
                "Removing or disabling an inherited Service or Tool in a Target patch is not supported.",
            });
  }
  if (issues.length) throw issuesError("Project", issues);
}
export function parseProjectConfig(value: unknown) {
  refuseUnsupportedShapes(value);
  const result = projectConfigSchema.safeParse(value);
  if (!result.success) throw validationError("Project", result.error.issues);
  return result.data;
}
export const hostConfigSchema = z.strictObject({
  deploy: z
    .strictObject({
      production_branch: text
        .default("main")
        .describe(
          "Production branch for a Project whose rig.yaml sets none, and the rig init default when origin/HEAD names no branch.",
        ),
      previews: z
        .strictObject({
          max: z
            .number()
            .int()
            .min(1)
            .default(25)
            .describe(
              "Most Previews one Project may have; every recorded Preview counts, running or stopped.",
            ),
          replace_policy: z
            .enum(["oldest", "reject"])
            .default("oldest")
            .describe(
              "At the limit: oldest destroys the oldest Preview to make room (incomplete deploys first, then stopped, then running); reject refuses the deploy.",
            ),
        })
        .prefault({})
        .describe("Preview limit."),
    })
    .prefault({})
    .describe("Host deployment defaults."),
  providers: z
    .strictObject({
      caddy: z
        .strictObject({
          caddyfile: text
            .optional()
            .describe(
              "File Rig writes its marked route blocks into; defaults to proxy/Caddyfile under the Rig state directory.",
            ),
          host_caddyfile: text
            .optional()
            .describe(
              "Caddyfile the running Caddy loads; it must be the route file or import it. Defaults to the first of /usr/local/etc/Caddyfile, /opt/homebrew/etc/Caddyfile, /etc/caddy/Caddyfile that exists.",
            ),
          extra_config: z
            .array(text)
            .default([])
            .describe(
              "Extra trusted Caddy directives added inside every site block Rig writes.",
            ),
          reload: z
            .strictObject({
              mode: z
                .enum(["manual", "command"])
                .default("manual")
                .describe(
                  "manual: Rig writes the route file and you reload Caddy. command: Rig runs the reload command after each route change and restores the previous routes when it fails.",
                ),
              command: text
                .optional()
                .describe(
                  "Host Caddy reload command; required when mode is command.",
                ),
            })
            .superRefine((reload, context) => {
              if (reload.mode === "command" && !reload.command?.trim())
                context.addIssue({
                  code: "custom",
                  path: ["command"],
                  message:
                    "Command reload mode requires an explicit nonblank command.",
                });
            })
            .prefault({})
            .describe("Reload behavior."),
        })
        .prefault({})
        .describe("Caddy provider settings."),
    })
    .prefault({})
    .describe("Provider settings."),
  diagnostics: z
    .strictObject({
      retention_days: z
        .number()
        .int()
        .min(1)
        .default(14)
        .describe("Days of Diagnostic logs to keep."),
      level: z
        .enum(["debug", "info", "warn", "error"])
        .default("info")
        .describe("Diagnostic log verbosity."),
    })
    .prefault({})
    .describe("Rig Diagnostic log policy."),
});
export function parseHostConfig(value: unknown) {
  const result = hostConfigSchema.safeParse(value);
  if (!result.success) throw validationError("Host", result.error.issues);
  return result.data;
}

/** Human guidance contains field paths and plain rules, never input values. */
function validationError(
  scope: string,
  issues: readonly z.core.$ZodIssue[],
): ConfigError {
  const safe = (value: string) =>
    value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
  return issuesError(
    scope,
    issues.map(explainIssue).map((issue) => ({
      path: issue.path.map((part) => safe(String(part))),
      message: safe(issue.message),
    })),
  );
}
function issuesError(
  scope: string,
  details: readonly { path: string[]; message: string }[],
): ConfigError {
  const hint =
    "Fix " +
    details
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.path.join(".") || "config"}: ${issue.message.replace(/\.$/, "")}`,
      )
      .join("; ") +
    ".";
  return new ConfigError(
    `Invalid ${scope} configuration.`,
    "invalid_config",
    { issues: details },
    hint.slice(0, 900),
  );
}
/** A union failure is explained by the branch the input came closest to: the one whose
 * discriminator matched and which raised the fewest problems, with the field path joined. */
function explainIssue(issue: z.core.$ZodIssue): {
  path: PropertyKey[];
  message: string;
} {
  if (issue.code === "invalid_union" && issue.errors.length) {
    const branches = issue.errors.filter((branch) => branch.length);
    const discriminators = branches.map((branch) =>
      branch[0]!.code === "invalid_value" ? branch[0] : undefined,
    );
    // Every branch rejected its own kind marker: the input chose no kind at all.
    if (branches.length && discriminators.every(Boolean)) {
      const choices = new Map<string, Set<string>>();
      for (const marker of discriminators) {
        const field = marker!.path.join(".");
        const values = choices.get(field) ?? new Set<string>();
        for (const value of marker!.values) values.add(JSON.stringify(value));
        choices.set(field, values);
      }
      return {
        path: [...issue.path],
        message: `must set ${[...choices]
          .map(
            ([field, values]) => `${field} to one of ${[...values].join(", ")}`,
          )
          .join(" or ")}`,
      };
    }
    const nearest = [...branches].sort(
      (a, b) =>
        Number(a[0]!.code === "invalid_value") -
          Number(b[0]!.code === "invalid_value") || a.length - b.length,
    )[0];
    if (nearest) {
      const inner = explainIssue(nearest[0]!);
      return { path: [...issue.path, ...inner.path], message: inner.message };
    }
  }
  return { path: [...issue.path], message: describeIssue(issue) };
}
/** The rule a field broke, in words a user can act on; Zod's own text names patterns and internals. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const quoted = (values: readonly unknown[]) =>
    values.map((value) => JSON.stringify(value)).join(", ");
  switch (issue.code) {
    case "unrecognized_keys":
      return `has no field named ${quoted(issue.keys)}`;
    case "invalid_type":
      return issue.expected === "nonoptional"
        ? "is required"
        : `must be ${/^[aeiou]/.test(issue.expected) ? "an" : "a"} ${issue.expected}`;
    case "invalid_value":
      return `must be one of ${quoted(issue.values)}`;
    case "too_small":
      return issue.origin === "string"
        ? issue.minimum === 1
          ? "must not be empty"
          : `must have at least ${issue.minimum} characters`
        : issue.origin === "array"
          ? `must list at least ${issue.minimum} entries`
          : `must be at least ${issue.minimum}`;
    case "too_big":
      return issue.origin === "string"
        ? `must have at most ${issue.maximum} characters`
        : issue.origin === "array"
          ? `must list at most ${issue.maximum} entries`
          : `must be at most ${issue.maximum}`;
    case "invalid_key":
      return issue.issues[0] ? describeIssue(issue.issues[0]) : issue.message;
    case "invalid_format":
      return /^Invalid /.test(issue.message)
        ? "does not have the expected format"
        : issue.message;
    default:
      return issue.message;
  }
}
