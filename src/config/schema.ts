import { z } from "zod";
import { ConfigError } from "./errors";
import { referenceResolver } from "./references";
import { MAX_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
import {
  HEALTHCHECK_DEFAULTS,
  MIN_HEALTHCHECK_INTERVAL_SECONDS,
  healthcheckInForce,
  healthcheckListProblem,
  isHealthUrl,
  type HealthcheckSettings,
} from "./healthcheck";
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
  `References: ${scope === "service" ? "${port} (this Service's only port), ${ports.<port>} (one of its named ports), " : ""}\${environment.NAME}, \${services.<service>.port} (a Service's only port), \${services.<service>.ports.<port>}, a scalar setting by its path such as \${services.api.stop_timeout}, \${rig.target}, \${rig.workspace}, \${rig.host}, \${rig.url}${scope === "service" ? ", ${rig.data}" : ""}. $\${VAR} writes a literal \${VAR}.`;
const command = text
  .refine(
    (value) => localhostCommand(value.replace(/\$\{[^}]+\}/g, "1234")),
    "Explicit network bindings must use 127.0.0.1 or localhost.",
  )
  .describe(
    "Shell command run with /bin/sh -c; explicit bindings must be localhost only. Interpolated values with spaces or shell characters are single-quoted unless the placeholder is already quoted.",
  );
export { isHealthUrl } from "./healthcheck";
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
/** A Service's stop grace: at least one second, at most one hour. */
const stopTimeout = text
  .refine((value) => {
    const seconds = durationSeconds(value);
    return seconds >= 1 && seconds <= MAX_STOP_TIMEOUT_SECONDS;
  }, "must be a duration from 1s to 1h, such as 10s, 2m or 1h")
  .describe(
    "How long the Service may take to exit after its stop signal (SIGTERM) before Rig ends it with SIGKILL, such as 2m (default 10s, at most 1h). Every stop waits for it: rig down, rig restart, a deploy that replaces or rolls back the Target, a Preview destroy, and the stop of a failed start. rig down --kill skips it.",
  );
const envName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "must be an environment variable name: letters, digits and '_', not starting with a digit",
  );
/** Public inline environment; only wildcard addresses under bind-style keys are rejected, since HOST may also name a public hostname. */
const environmentMap = (scope: ReferenceScope) =>
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
  environmentMap(scope).describe(
    "Public environment values passed to the process; never put secrets here. Values may use ${...} references. Bind-style keys such as HOST or BIND_ADDR may not use a wildcard address.",
  );
const envFile = (scope: ReferenceScope) =>
  z
    .union([text, z.array(text).min(1)])
    .describe(
      `Environment file path, or an ordered list of paths where later files win. Listed files are required and hold plain KEY=value data; their contents never take part in \${...} references. Relative paths resolve against the workspace root, never against a Service's working_dir; ~ is the operator home. The path itself may use references. ${referencesIn(scope)}`,
    );
const buildRule = (where: string) =>
  `run with /bin/sh -c ${where} during preparation, never as a start hook; explicit bindings must be localhost only.`;
/** A shared or Tool build runs with Project inputs only. */
const PROJECT_BUILD_REFERENCES = `${referencesIn("project")} A Service's environment is not available here.`;
const build = command.describe(
  `Shell build command ${buildRule("in the workspace")} ${PROJECT_BUILD_REFERENCES}`,
);
const buildTimeout = duration.describe(
  "Build duration budget such as 10m; a build past it is terminated and recorded as failed, never as completed.",
);
const portName = text
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "must start with a lowercase letter or digit and contain only lowercase letters, digits or '-'",
  )
  .describe(
    "Port name used in ${ports.<port>} and ${services.<service>.ports.<port>} references. A Service with exactly one port can also be referenced as ${port} in its own settings and as ${services.<service>.port} anywhere.",
  );
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
/** A directory inside the workspace, written relative to it: no absolute path, no ~, no '..' segment and no reference, so
 * it can never name a directory outside the checkout a Target runs from. */
function insideWorkspace(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.includes("${") &&
    !value.split("/").includes("..")
  );
}
const workingDir = text
  .refine(
    insideWorkspace,
    "must be a directory inside the workspace, relative to it, such as apps/web: no absolute path, ~, '..' or reference",
  )
  .describe(
    "Directory the Service's command, its build and its healthcheck command run in, relative to the workspace, such as apps/web (default: the workspace root). It cannot leave the workspace: absolute paths, ~, '..' and references are refused. Relative env_file paths and ${rig.workspace} still mean the workspace root.",
  );
/** A local URL or a command that addresses only 127.0.0.1 or localhost, judged with every reference standing in as a port. */
const localCheck = (value: string) =>
  localhostHealth(value.replace(/\$\{[^}]+\}/g, "1234"));
const LOCAL_CHECK = "Health checks must address 127.0.0.1 or localhost.";
const healthcheckTest = z
  .union([
    text
      .refine(localCheck, LOCAL_CHECK)
      .describe(
        `A shell command run with /bin/sh -c in working_dir that passes on exit 0, as in Compose; a string starting with / is a command too. Rig's one extension: a string starting with http:// or https:// is an HTTP GET of a local URL that passes with a status below 400, without following a redirect. Referenced values in a shell command are quoted as in command. ${referencesIn("service")}`,
      ),
    z
      .array(z.string())
      .min(1)
      .superRefine((test, ctx) => {
        const problem = healthcheckListProblem(test);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
        else if (test[0] !== "NONE" && !localCheck(test.slice(1).join(" ")))
          ctx.addIssue({ code: "custom", message: LOCAL_CHECK });
      })
      .describe(
        `Compose's list forms: ["CMD-SHELL", "<command>"] runs a shell command; ["CMD", "<program>", "<argument>", ...] runs the program with exactly those arguments, without a shell; ["NONE"] turns the healthcheck off. ${referencesIn("service")}`,
      ),
  ])
  .describe(
    "What one check runs: a shell command, a local http(s) URL, or one of Compose's list forms. Without it, a check passes when every declared port accepts a connection.",
  );
const healthcheck = z
  .strictObject({
    test: healthcheckTest.optional(),
    interval: duration
      .refine(
        (value) => durationSeconds(value) >= MIN_HEALTHCHECK_INTERVAL_SECONDS,
        `must be at least ${MIN_HEALTHCHECK_INTERVAL_SECONDS}s`,
      )
      .optional()
      .describe(
        `Time between checks while the Service runs, such as 1m (default ${HEALTHCHECK_DEFAULTS.interval}, at least ${MIN_HEALTHCHECK_INTERVAL_SECONDS}s).`,
      ),
    timeout: duration
      .optional()
      .describe(
        `How long one check may take before it counts as failed, such as 5s (default ${HEALTHCHECK_DEFAULTS.timeout}).`,
      ),
    retries: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Failed checks in a row before the Service is unhealthy (default ${HEALTHCHECK_DEFAULTS.retries}). One passing check makes it healthy again.`,
      ),
    start_period: duration
      .optional()
      .describe(
        `How long a start may take to pass its first check, such as 2m (default ${HEALTHCHECK_DEFAULTS.start_period}; Compose's is 0s). Until then Rig checks every 100 ms, not at interval, and a Service that depends on this one starts only once a check passed.`,
      ),
    disable: z
      .boolean()
      .optional()
      .describe(
        "true turns the healthcheck off, mainly in a Target patch to drop an inherited one; the Service then behaves as if it had none, start_period included.",
      ),
    on_failure: z
      .enum(["report", "restart"])
      .optional()
      .describe(
        "What Rig does once the Service is unhealthy (Rig's extension; Compose never restarts for health): report (default) shows it in status and records it in Activity; restart also stops it within its stop_timeout and starts it again, at once and then after 1m, 5m, 15m and every hour while it stays unhealthy.",
      ),
  })
  .describe(
    "Docker Compose's healthcheck. The first passing check is the start gate, and checks repeat at interval while the Service runs. Without a healthcheck, start waits for every declared port to accept a connection and nothing is checked afterwards.",
  );
const serviceFields = {
  command: command.describe(
    `Foreground shell command run with /bin/sh -c in working_dir (default: the workspace root); explicit bindings must be localhost only. Referenced values with spaces or shell characters are single-quoted unless the reference is already quoted. ${referencesIn("service")}`,
  ),
  build: command
    .describe(
      `Shell build command of this Service, ${buildRule("in its working_dir (default: the workspace root)")} ${referencesIn("service")}`,
    )
    .optional(),
  build_timeout: buildTimeout.optional(),
  working_dir: workingDir.optional(),
  ports: ports.optional(),
  healthcheck: healthcheck.optional(),
  stop_timeout: stopTimeout.optional(),
  depends_on: z
    .array(entryName)
    .optional()
    .describe(
      "Services that must be running and have passed their start check (their healthcheck, or without one every declared port accepting a connection) before this one starts; a later dependency failure does not restart this Service.",
    ),
  restart: restart.optional(),
  environment: env("service").optional(),
  env_file: envFile("service").optional(),
};
const toolFields = {
  build: build.optional(),
  build_timeout: buildTimeout.optional(),
  bin: text.describe(
    `Executable path relative to the workspace; published in <RIG_ROOT>/bin under the Tool name for the stable Target, as <tool>-dev for the working Target and as <tool>-<preview name> for a Preview. An executable is copied there and runs from there, so it must be self-contained, like a compiled binary, or name the checkout it needs itself: dirname "$0" is <RIG_ROOT>/bin. A source file (.ts, .tsx, .js, .jsx, .mjs, .cjs) is not copied; it is published as a shim that runs it in place with the bun rigd install recorded, so its relative imports resolve. ${referencesIn("project")}`,
  ),
};
const tool = z.strictObject(toolFields);
/** A proxy upstream: a Service name, `${services.<name>.port}`, or `${services.<name>.ports.<port>}`. */
const PROXY_UPSTREAM =
  /^(?:([a-z0-9][a-z0-9-]*)|\$\{services\.([a-z0-9][a-z0-9-]*)\.(?:port|ports\.([a-z0-9][a-z0-9-]*))\})$/;
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
        PROXY_UPSTREAM,
        "must name a Service, such as web, or one of its ports, such as ${services.web.ports.http}",
      )
      .describe(
        "Upstream of this prefix: a Service name such as web, which means its only port, or exactly one port reference such as ${services.web.ports.http} or ${services.web.port}. No other reference or text is allowed.",
      ),
  )
  .describe(
    "Path prefix to the Service, or the Service port, that serves it. Prefixes match at a slash boundary, longest first, and the upstream path is unchanged; '/' is required. Without proxy, a Target with a hostname routes '/' to the one Service that declares ports when that Service declares exactly one.",
  );
/** A build in a Target patch: a command, or false to turn the inherited build off for that role. */
const BUILD_OFF =
  "false turns the inherited build off for this role's Targets; leaving the key out keeps it.";
/** What a patch build may be, for the value that is neither. */
const PATCH_BUILD_SHAPES =
  "must be a command, or false to turn the inherited build off";
const patchBuild = <T extends z.ZodType>(command: T) =>
  z
    .union([command, z.literal(false)], { error: PATCH_BUILD_SHAPES })
    .optional()
    .describe(`${command.description ?? ""} In a Target patch, ${BUILD_OFF}`);
/** Settings every role may patch. Maps merge per key; lists and scalars replace. */
const patchFields = {
  domain: domain
    .optional()
    .describe(
      `Hostname for this role's Targets, such as \${rig.target}.preview.app.test. ${DOMAIN_REFERENCE}`,
    ),
  build: patchBuild(build),
  build_timeout: buildTimeout.optional(),
  environment: env("project").optional(),
  env_file: envFile("project").optional(),
  proxy: proxy.optional(),
  services: z
    .record(
      entryName,
      z
        .strictObject(serviceFields)
        .partial()
        .extend({ build: patchBuild(serviceFields.build.unwrap()) }),
    )
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
/** The selector of every Preview; it is also the preview role's key under targets. */
export const PREVIEW_SELECTOR = "preview";
/** The three Target roles. `working` and `stable` are also the fixed names of the one Target each role has. */
export const TARGET_ROLES = ["working", "stable", "preview"] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];
/** The suffix the working Target's Tools are published under, `<tool>-dev`: "working" is too long to type every time. */
export const WORKING_TOOL_SUFFIX = "dev";
const ROLE_SWITCH_SHAPES = "must be true, false or a map of settings";
/** One role's switch: true or a settings patch turns it on; false, or leaving the key out, keeps it off. */
const roleSwitch = (description: string) =>
  z
    .union([z.boolean(), z.strictObject(patchFields)], {
      error: ROLE_SWITCH_SHAPES,
    })
    .optional()
    .describe(description);
const targets = z.strictObject({
  working: roleSwitch(
    "The working Target, which runs this checkout as it is: true or a settings patch turns it on; false or leaving it out keeps it off. Its Tools are published as <tool>-dev.",
  ),
  stable: roleSwitch(
    "The stable Target, which serves the Production branch: true or a settings patch turns it on; false or leaving it out keeps it off. Its Tools are published under their plain names.",
  ),
  preview: roleSwitch(
    "Previews of other Branches: true or a settings patch applied to every Preview turns them on; false or leaving it out keeps them off. Preview names come from their Branch.",
  ),
});
/** Whether a role is on: its key under targets is true or a settings map. False, a missing key, or no targets key at all is
 * off. */
export function targetOn(
  config: { targets?: Readonly<Partial<Record<TargetRole, unknown>>> },
  role: TargetRole,
): boolean {
  const value = config.targets?.[role];
  return value === true || isRecord(value);
}
type Fields = Readonly<Record<string, unknown>>;
type Report = (
  path: PropertyKey[],
  message: string,
  rule?: typeof RENAMED_RULE,
) => void;
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
/** One Service as the cross-field rules read it. */
type GraphService = Fields & {
  command?: string;
  build?: string;
  healthcheck?: HealthcheckSettings;
  depends_on?: readonly string[];
  ports?: Readonly<Record<string, number | "auto">>;
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
  proxy?: Readonly<Record<string, string>>;
};
type GraphConfig = GraphSettings & {
  targets?: Partial<Record<TargetRole, GraphSettings | boolean>>;
};
export const projectConfigSchema = z
  .strictObject({
    name,
    description: z.string().optional().describe("Project description."),
    production_branch: text
      .optional()
      .describe(
        "Branch the stable Target deploys; defaults to the Host deploy.production_branch, then main.",
      ),
    domain: domain
      .optional()
      .describe(
        `Hostname of the stable Target. A Preview defaults to this domain with a dash and its name after the first label, so app.example.com gives app-<preview-name>.example.com; the working Target has no hostname unless its patch sets one. ${DOMAIN_REFERENCE}`,
      ),
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
    environment: env("project").optional(),
    env_file: envFile("project").optional(),
    services: z
      .record(entryName, z.strictObject(serviceFields))
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
        "Which Targets are on, keyed by their fixed names working, stable and preview, each true, false or a settings patch. Only the Targets it turns on are on; without this key every Target is off.",
      ),
  })
  .superRefine((parsed, ctx) => {
    const config = parsed as GraphConfig;
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
    const reported = new Set<string>();
    const report: Report = (path, message, rule) => {
      if (reported.has(message)) return;
      reported.add(message);
      ctx.addIssue({
        code: "custom",
        path,
        message,
        ...(rule ? { params: { rule } } : {}),
      });
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
      if (
        role === "working" ? !patched : config.domain === undefined && !patched
      )
        continue;
      const problem = missingProxy(
        patchSettings(config, role) as GraphSettings,
        role,
        patched,
      );
      if (problem)
        report(patched ? ["targets", role, "domain"] : ["domain"], problem);
    }
  });
type ParsedProject = z.infer<typeof projectConfigSchema>;
/** Project settings with one role's patch applied; the Target switches never merge into them. */
export type ProjectSettings = Omit<ParsedProject, "targets">;
export function patchedSettings(
  config: ParsedProject,
  role: TargetRole,
): ProjectSettings {
  return patchSettings(config, role) as ProjectSettings;
}
/** The settings one role may patch. */
export type RolePatch = Exclude<
  NonNullable<ParsedProject["targets"]>[TargetRole],
  boolean | undefined
>;
/** One role's settings patch: its map, or nothing when the role is only switched on or off. */
export function rolePatch(config: ParsedProject, role: TargetRole): RolePatch {
  const patch = config.targets?.[role];
  return isRecord(patch) ? patch : {};
}
/** The patch rule: the base settings, without the Target switches, merged with one role's patch. */
function patchSettings(config: Fields, role: TargetRole): Fields {
  const { targets, ...base } = config;
  const patch: Record<string, unknown> = {
    ...(isRecord(targets) && isRecord(targets[role]) ? targets[role] : {}),
  };
  // A patch naming an unknown entry is reported by validation; merging would otherwise invent a partial entry.
  for (const kind of ["services", "tools"] as const)
    if (isRecord(patch[kind]))
      patch[kind] = Object.fromEntries(
        Object.entries(patch[kind]).filter(([key]) =>
          Object.hasOwn(isRecord(base[kind]) ? base[kind] : {}, key),
        ),
      );
  const merged = mergeSettings(base, patch);
  // `build: false` in a patch turns the inherited build off: the role's settings have none.
  const unbuilt = (settings: Record<string, unknown>) => {
    if (settings.build === false) delete settings.build;
  };
  unbuilt(merged);
  if (isRecord(merged.services))
    for (const service of Object.values(merged.services))
      if (isRecord(service)) unbuilt(service as Record<string, unknown>);
  return merged;
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
  const fields: [string[], string | undefined][] = [
    [["build"], settings.build],
    ...Object.entries(settings.environment ?? {}).map(
      ([key, value]): [string[], string] => [["environment", key], value],
    ),
    ...[settings.env_file ?? []]
      .flat()
      .map((value): [string[], string] => [["env_file"], value]),
  ];
  for (const [name, service] of Object.entries(settings.services ?? {})) {
    const own = ["services", name];
    for (const field of ["command", "build"] as const)
      fields.push([[...own, field], service[field]]);
    const test = service.healthcheck?.test;
    if (typeof test === "string")
      fields.push([[...own, "healthcheck", "test"], test]);
    else
      for (const [index, value] of (test ?? []).entries())
        if (index > 0)
          fields.push([[...own, "healthcheck", "test", String(index)], value]);
    for (const [key, value] of Object.entries(service.environment ?? {}))
      fields.push([[...own, "environment", key], value]);
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
      report(
        [...at, ...path],
        error.message,
        error.code === "renamed_reference" ? RENAMED_RULE : undefined,
      );
    }
  }
}
const PATCH_IDENTITY_KEYS: Readonly<Record<string, string>> = {
  production_branch:
    "The Production branch is Project-wide; set production_branch at the top level.",
  description: "The Project description is not a Target setting.",
  targets: "A Target patch cannot contain targets.",
  role: "A Target's role is its fixed key (working, stable or preview) and cannot change.",
  // Rig once let rig.yaml rename the working and stable Targets (ADR 0006); ADR 0010 fixed their names.
  name: "Target names are fixed (working, stable, preview); delete this line.",
};
/** `supervisor` chose between rigd and per-Service launchd agents until launchd supervision was removed; rigd now supervises
 * every Service, so a file that still sets it is told to delete the line rather than that the field is unknown. */
const REMOVED_SUPERVISOR =
  "was removed because rigd supervises every Service; delete this line";
/** `format` named a rig.yaml format until Rig read more than one; there is one format now, so the key is refused with that
 * instruction rather than as an unknown field. */
const REMOVED_FORMAT =
  "was removed because Rig reads one rig.yaml format; delete this line";
/** A Service's `health` block held its start check and ongoing health checks until ADR 0009 removed both; ADR 0012 brought
 * them back as Docker Compose's `healthcheck`, so a file that still has the block is told where its settings go. */
const REMOVED_HEALTH =
  "`health` is now `healthcheck`, in Docker Compose's shape: write check as test, start_timeout as start_period and failures as retries; interval, timeout and on_failure keep their names, and retry_for is gone";
/** `ready` and `ready_timeout` were a Service's start check until ADR 0012 replaced them with Compose's `healthcheck`. */
const SERVICE_MOVES: Readonly<Record<string, string>> = {
  ready: "`ready` is now `healthcheck.test`; move it there",
  ready_timeout: "`ready_timeout` is now `healthcheck.start_period`",
};
/** Keys renamed to their Docker Compose names (ADR 0011). A file that still uses the old name is told the new one rather than
 * that the key is unknown. Project settings and a Target patch had `env`; a Service had `run` and `env`. */
const SETTINGS_RENAMES: Readonly<Record<string, string>> = {
  env: "environment",
};
const SERVICE_RENAMES: Readonly<Record<string, string>> = {
  run: "command",
  ...SETTINGS_RENAMES,
};
const renamedKey = (from: string, to: string) =>
  `\`${from}\` is now \`${to}\`; rename this key`;
/** `build: false` only means something against a build a Target patch inherits; at the top level leaving the key out
 * already means no build. */
const BASE_BUILD_OFF =
  "build: false only turns an inherited build off in a Target patch; delete this line for no build";
/** A Tool's build makes its bin, so it cannot be turned off; only the Project build and a Service build can. */
const TOOL_BUILD_OFF =
  "build: false is not allowed for a Tool, whose build makes its bin; give another command or leave the key out";
/** Every Service mapping of a raw config value with its path: `services.<name>` and `targets.<role>.services.<name>`. */
function serviceBlockPaths(value: Fields): [string[], Fields][] {
  const blocks: [string[], Fields][] = [];
  const collect = (services: unknown, at: string[]) => {
    if (isRecord(services))
      for (const [name, service] of Object.entries(services))
        if (isRecord(service)) blocks.push([[...at, name], service]);
  };
  collect(value.services, ["services"]);
  if (isRecord(value.targets))
    for (const [role, patch] of Object.entries(value.targets))
      if (isRecord(patch))
        collect(patch.services, ["targets", role, "services"]);
  return blocks;
}
/** Refusals that need their own guidance, checked before the schema so they are not reported as generic unknown keys. */
function refuseUnsupportedShapes(value: unknown): void {
  if (!isRecord(value)) return;
  const issues: Issue[] = [];
  if (Object.hasOwn(value, "format"))
    issues.push({ path: ["format"], message: REMOVED_FORMAT });
  if (Object.hasOwn(value, "supervisor"))
    issues.push({ path: ["supervisor"], message: REMOVED_SUPERVISOR });
  const renames = (
    block: Fields,
    at: string[],
    names: Readonly<Record<string, string>>,
  ) => {
    for (const [from, to] of Object.entries(names))
      if (Object.hasOwn(block, from))
        issues.push({
          path: [...at, from],
          message: renamedKey(from, to),
          rule: RENAMED_RULE,
        });
  };
  renames(value, [], SETTINGS_RENAMES);
  const builds: [string[], unknown][] = [[["build"], value.build]];
  if (isRecord(value.services))
    for (const [name, service] of Object.entries(value.services))
      if (isRecord(service))
        builds.push([["services", name, "build"], service.build]);
  for (const [path, build] of builds)
    if (build === false) issues.push({ path, message: BASE_BUILD_OFF });
  // A Tool's bin comes from its build, so no role may turn a Tool build off.
  const toolBlocks: [string[], unknown][] = [[["tools"], value.tools]];
  if (isRecord(value.targets))
    for (const [role, patch] of Object.entries(value.targets))
      if (isRecord(patch))
        toolBlocks.push([["targets", role, "tools"], patch.tools]);
  for (const [at, tools] of toolBlocks)
    if (isRecord(tools))
      for (const [name, tool] of Object.entries(tools))
        if (isRecord(tool) && tool.build === false)
          issues.push({
            path: [...at, name, "build"],
            message: TOOL_BUILD_OFF,
          });
  for (const [path, service] of serviceBlockPaths(value)) {
    if (Object.hasOwn(service, "health"))
      issues.push({
        path: [...path, "health"],
        message: REMOVED_HEALTH,
        rule: RENAMED_RULE,
      });
    // Renamed like run and env (ADR 0011), so a deployed revision that still has them is told apart from a broken file.
    for (const [key, message] of Object.entries(SERVICE_MOVES))
      if (Object.hasOwn(service, key))
        issues.push({ path: [...path, key], message, rule: RENAMED_RULE });
    renames(service, path, SERVICE_RENAMES);
  }
  for (const [role, patch] of Object.entries(
    isRecord(value.targets) ? value.targets : {},
  )) {
    if (!isRecord(patch)) continue;
    renames(patch, ["targets", role], SETTINGS_RENAMES);
    if (Object.hasOwn(patch, "supervisor"))
      issues.push({
        path: ["targets", role, "supervisor"],
        message: REMOVED_SUPERVISOR,
      });
    for (const [key, message] of Object.entries(PATCH_IDENTITY_KEYS))
      if (Object.hasOwn(patch, key))
        issues.push({
          path: ["targets", role, key],
          // A role that held only its name, as rig init used to write it, would be left empty and so off.
          message:
            key === "name" && Object.keys(patch).length === 1
              ? `${message.replace(/\.$/, "")}, and write \`${role}: true\` to keep it on.`
              : message,
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
export function parseProjectConfig(value: unknown): ProjectConfig {
  refuseUnsupportedShapes(value);
  const result = projectConfigSchema.safeParse(value);
  if (!result.success) throw validationError("Project", result.error.issues);
  return result.data;
}
export type ProjectConfig = ParsedProject;
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
              "Extra trusted Caddy directives added inside every site block Rig writes, such as import cloudflare. They may use snippets the Host Caddyfile defines once it imports the route file.",
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
  logs: z
    .strictObject({
      max_bytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .default(64 * 1024 * 1024)
        .describe(
          "Size in bytes at which a Target log file is rotated: the full file is renamed and writing starts a new one. Default 67108864 (64 MiB); at least 1048576 (1 MiB).",
        ),
      generations: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(1)
        .describe(
          "How many rotated files are kept beside the current one, newest as .1; an older one is deleted. Default 1; 0 keeps none. A Target log uses at most about max_bytes × (generations + 1) per file.",
        ),
    })
    .prefault({})
    .describe(
      "Size limits for Target logs: each Target's target.jsonl. Every writer reads a change within a few seconds.",
    ),
  // Retired, not refused: rigd reads this file as it starts, so a refusal would keep it from starting at all.
  alerts: z.unknown().optional().meta({
    deprecated: true,
    description:
      "No longer used: Rig sends no alerts. The section is ignored, and rig doctor asks you to delete it.",
  }),
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
    issues.map((issue) => {
      const explained = explainIssue(issue);
      const rule =
        issue.code === "custom" && issue.params?.rule === RENAMED_RULE
          ? RENAMED_RULE
          : undefined;
      return {
        path: explained.path.map((part) => safe(String(part))),
        message: safe(explained.message),
        ...(rule ? { rule } : {}),
      };
    }),
  );
}
/** One reported problem of a config document. `rule` marks a kind of problem a caller treats on its own. */
interface Issue {
  path: string[];
  message: string;
  rule?: typeof RENAMED_RULE;
}
/** A key or reference path written under a name ADR 0011 or 0012 replaced with its Compose name, such as `run`,
 * `${env.X}` or `ready`. */
const RENAMED_RULE = "renamed";
/** Whether a refused config was refused, at least in part, because it uses names from before ADR 0011 or 0012: a rig.yaml
 * committed before the rename, which a deployed revision may still hold. */
export function usesRenamedKeys(error: ConfigError): boolean {
  const issues = error.context.issues;
  return (
    Array.isArray(issues) &&
    issues.some(
      (issue: unknown) =>
        isRecord(issue) && (issue as Partial<Issue>).rule === RENAMED_RULE,
    )
  );
}
function issuesError(scope: string, details: readonly Issue[]): ConfigError {
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
    // A Target switch that is neither a boolean nor a map, or a patch build that is neither a command nor false, is
    // explained by its own message, which names both shapes.
    if (
      (issue.message === ROLE_SWITCH_SHAPES ||
        issue.message === PATCH_BUILD_SHAPES) &&
      branches.length &&
      branches.every(
        (branch) =>
          branch.length === 1 &&
          (branch[0]!.code === "invalid_type" ||
            branch[0]!.code === "invalid_value") &&
          branch[0]!.path.length === 0,
      )
    )
      return { path: [...issue.path], message: issue.message };
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
    // On a tie, the branch whose problem lies deeper is the one the input's own shape chose: a settings map with one bad
    // field is explained by that field, not by the boolean it is not.
    const nearest = [...branches].sort(
      (a, b) =>
        Number(a[0]!.code === "invalid_value") -
          Number(b[0]!.code === "invalid_value") ||
        a.length - b.length ||
        b[0]!.path.length - a[0]!.path.length,
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
