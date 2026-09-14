import { z } from "zod";
import { mergeComponentOverride } from "./override.js";
import { ConfigError } from "./errors.js";
const text = z.string().min(1);
const name = text
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    "must start with a letter or digit and contain only letters, digits, '_' or '-'",
  )
  .describe("Stable registered Project name.");
const componentName = text
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "must start with a lowercase letter or digit and contain only lowercase letters, digits or '-'",
  )
  .describe("Component name used in dependencies and output.");
const port = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .describe("Local TCP port from 1 to 65535.");
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
/** Inline environment; only wildcard addresses under bind-style keys are rejected, since HOST may also name a public hostname. */
const environment = z.record(z.string(), z.string()).superRefine((env, ctx) => {
  for (const [key, value] of Object.entries(env))
    if (BIND_KEY.test(key) && WILDCARD_ADDRESS.test(value.trim()))
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} must bind to 127.0.0.1 or localhost, not a wildcard address.`,
      });
});
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
const route = text
  .regex(/^[^\s;"`{}]+$/)
  .or(text.regex(/^\$\{[^}]+\}[^\s;"`]*$/))
  .describe("Single domain token; interpolation is supported.");
/** Hook commands run with /bin/sh -c and are held to the same localhost rule as Component commands; interpolated values are shell-quoted the same way.
 * A lane override merges hooks per key, like env. */
const hooks = z.strictObject({
  preStart: command
    .optional()
    .describe(
      "Run before starting; skipped when nothing needs to start. A Project preStart runs before installs and Component hooks.",
    ),
  postStart: command
    .optional()
    .describe(
      "Run after readiness: after the health check passes, or after the start grace period when the Component has no health check. A Project postStart runs after routing.",
    ),
  preStop: command
    .optional()
    .describe(
      "Run before stopping active managed processes; skipped when already stopped.",
    ),
  postStop: command.optional().describe("Run after stopping."),
});
const common = {
  env: environment
    .optional()
    .describe(
      "Inline process environment. Bind-style keys such as HOST or BIND_ADDR may not use a wildcard address.",
    ),
  envFile: text
    .optional()
    .describe(
      "Environment file relative to the workspace. live and Preview files must stay inside the workspace; only local may point elsewhere.",
    ),
  hooks: hooks
    .optional()
    .describe(
      "Component lifecycle hooks; a lane override merges them per key.",
    ),
  hookTimeout: z
    .number()
    .min(1)
    .optional()
    .describe(
      "Budget in seconds for this Component's hooks; a hook past it is killed and its output so far is kept in the Target logs. Defaults to the Project hookTimeout, then 120.",
    ),
};
const runtime = {
  command: command.optional(),
  port: port.optional(),
  health: health.optional(),
  readyTimeout: z
    .number()
    .min(1)
    .optional()
    .describe("Startup readiness timeout in seconds."),
  dependsOn: z
    .array(componentName)
    .optional()
    .describe("Components that must become ready first."),
};
const component = z.union([
  z.strictObject({
    mode: z.literal("managed").describe("Supervised long-running process."),
    ...runtime,
    command,
    ...common,
  }),
  z.strictObject({
    mode: z.literal("installed").describe("Installed executable."),
    entrypoint: text.describe("Executable path relative to the workspace."),
    build: z
      .string()
      .optional()
      .describe(
        "Build command before installation, run with /bin/sh -c; interpolated values are shell-quoted.",
      ),
    installName: componentName
      .optional()
      .describe("Installed executable name."),
    buildTimeout: z
      .number()
      .min(1)
      .optional()
      .describe(
        "Budget in seconds for build; a build past it is killed, its output so far is kept in the Target logs, and the previous installed artifact stays (default 600).",
      ),
    ...common,
  }),
  z.strictObject({
    uses: z.literal("sqlite").describe("Persistent SQLite dependency."),
    path: text
      .optional()
      .describe(
        "Database path; defaults to Target persistent storage. A relative path is inside the working copy for local and inside Target persistent storage for live and Previews, whose checkouts are replaced on every deploy. live and Preview paths must stay inside that storage; only local may point elsewhere.",
      ),
  }),
  z.strictObject({
    uses: z.literal("convex").describe("Convex Local dependency."),
    ...runtime,
    sitePort: port
      .optional()
      .describe(
        "Convex site-proxy port. Defaults to the port after the component's own port; when another Target already records that port, a free port is selected and recorded instead.",
      ),
    ...common,
  }),
  z.strictObject({
    uses: z.literal("postgres").describe("Postgres dependency."),
    ...runtime,
    ...common,
  }),
]);
const override = z.strictObject({
  ...runtime,
  sitePort: port.optional().describe("Convex site-proxy port."),
  entrypoint: text.optional().describe("Installed executable path override."),
  build: z.string().optional().describe("Build command override."),
  installName: componentName
    .optional()
    .describe("Installed executable name override."),
  buildTimeout: z
    .number()
    .min(1)
    .optional()
    .describe("Build budget override in seconds."),
  path: text.optional().describe("SQLite path override."),
  ...common,
});
const lane = z.strictObject({
  components: z
    .record(componentName, override)
    .optional()
    .describe("Overrides keyed by shared Component name."),
  env: environment
    .optional()
    .describe(
      "Environment inherited by every Component. Bind-style keys such as HOST or BIND_ADDR may not use a wildcard address.",
    ),
  envFile: text
    .optional()
    .describe(
      "Default environment file relative to the workspace, inherited by every Component. live and Preview files must stay inside the workspace.",
    ),
  proxy: z
    .strictObject({
      upstream: componentName.describe(
        "Managed Component receiving route traffic.",
      ),
    })
    .optional()
    .describe("Reverse proxy policy."),
  daemon: z
    .strictObject({
      enabled: z
        .boolean()
        .optional()
        .describe("Install persistent supervision."),
      keepAlive: z.boolean().optional().describe("Restart exited processes."),
    })
    .optional()
    .describe("Legacy supervision policy."),
  providers: z
    .strictObject({
      processSupervisor: z
        .enum(["rigd", "child", "launchd"])
        .optional()
        .describe(
          "Process supervisor for managed Components: rigd (default; child processes owned by the daemon), child (alias of rigd), or launchd (per-Component launchd agents). Unknown names are rejected before any plan is recorded.",
        ),
    })
    .optional()
    .describe("Provider selections."),
  domain: route
    .optional()
    .describe(
      "Hostname for this lane's Targets, replacing the Project domain; may use ${subdomain}.",
    ),
  subdomain: route.optional().describe("Preview subdomain template."),
  deployBranch: text
    .optional()
    .describe("Production branch for the Stable Target."),
  providerProfile: z
    .literal("default")
    .optional()
    .describe(
      "Provider profile. Only default is supported; test isolation uses explicit provider interfaces and RIG_ROOT.",
    ),
});
export const projectConfigSchema = z
  .strictObject({
    name,
    description: z.string().optional().describe("Project description."),
    domain: route
      .optional()
      .describe(
        "Hostname template for every Target. Use ${subdomain} (local, live, or the Preview branch slug) so Targets do not share a route.",
      ),
    hooks: hooks.optional().describe("Project lifecycle hooks."),
    hookTimeout: z
      .number()
      .min(1)
      .optional()
      .describe(
        "Budget in seconds for Project hooks, and the default for Component hooks; a hook past it is killed and its output so far is kept in the Target logs (default 120).",
      ),
    installTimeout: z
      .number()
      .min(1)
      .optional()
      .describe(
        "Budget in seconds for dependency installation on live and Preview Targets; an install past it is killed and its output so far is kept in the Target logs (default 600).",
      ),
    components: z
      .record(componentName, component)
      .describe("Shared Component definitions."),
    local: lane.optional().describe("Working copy Target overrides."),
    live: lane.optional().describe("Stable Target overrides."),
    deployments: lane.optional().describe("Preview template overrides."),
  })
  .superRefine((config, ctx) => {
    for (let [laneName, target] of Object.entries({
      base: undefined as z.infer<typeof lane> | undefined,
      local: config.local,
      live: config.live,
      deployments: config.deployments,
    })) {
      if (!target && laneName !== "base") continue;
      target ??= {};
      const definitions: Record<
        string,
        Record<string, unknown>
      > = Object.create(null);
      for (const [key, base] of Object.entries(config.components)) {
        const merged = mergeComponentOverride(base, target.components?.[key]);
        const result = component.safeParse(merged);
        if (!result.success)
          ctx.addIssue({
            code: "custom",
            path: [laneName, "components", key],
            message: "Overrides must match the Component kind.",
          });
        definitions[key] = merged;
        if (definitions[key].mode === "installed" && definitions[key].hooks)
          ctx.addIssue({
            code: "custom",
            path: [laneName, "components", key, "hooks"],
            message:
              "Hooks run around a Component's process; an installed executable has none. Use build for steps before installation.",
          });
      }
      for (const key of Object.keys(target.components ?? {}))
        if (!Object.hasOwn(config.components, key))
          ctx.addIssue({
            code: "custom",
            path: [laneName, "components", key],
            message: "Override references an unknown Component.",
          });
      const visiting = new Set<string>(),
        done = new Set<string>();
      const visit = (key: string): void => {
        if (visiting.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: [laneName, "components", key, "dependsOn"],
            message: "Component dependencies contain a cycle.",
          });
          return;
        }
        if (done.has(key)) return;
        visiting.add(key);
        for (const dependency of (definitions[key]?.dependsOn as
          string[] | undefined) ?? []) {
          if (
            !definitions[dependency] ||
            definitions[dependency]?.mode === "installed"
          )
            ctx.addIssue({
              code: "custom",
              path: [laneName, "components", key, "dependsOn"],
              message: `Dependency '${dependency}' must reference a managed or persistent Component.`,
            });
          else visit(dependency);
        }
        visiting.delete(key);
        done.add(key);
      };
      for (const key of Object.keys(definitions)) visit(key);
      if (
        "proxy" in target &&
        target.proxy &&
        !(
          definitions[target.proxy.upstream]?.mode === "managed" ||
          ["convex", "postgres"].includes(
            String(definitions[target.proxy.upstream]?.uses),
          )
        )
      )
        ctx.addIssue({
          code: "custom",
          path: [laneName, "proxy"],
          message: "Proxy upstream must reference a managed Component.",
        });
    }
  });
export function parseProjectConfig(value: unknown) {
  const result = projectConfigSchema.safeParse(value);
  if (!result.success) throw validationError("Project", result.error.issues);
  return result.data;
}
export const hostConfigSchema = z.strictObject({
  deploy: z
    .strictObject({
      productionBranch: text
        .default("main")
        .describe("Default Production branch."),
      generated: z
        .strictObject({
          maxActive: z
            .number()
            .int()
            .min(1)
            .default(5)
            .describe("Maximum active Previews per Project."),
          replacePolicy: z
            .enum(["oldest", "reject"])
            .default("oldest")
            .describe("Policy at the Preview limit."),
        })
        .prefault({})
        .describe("Preview inventory limits."),
    })
    .prefault({})
    .describe("Host deployment defaults."),
  providers: z
    .strictObject({
      defaultProfile: z
        .literal("default")
        .default("default")
        .describe(
          "Host provider profile. Only default is supported; unsupported profiles fail before runtime effects.",
        ),
      caddy: z
        .strictObject({
          caddyfile: text
            .optional()
            .describe(
              "File Rig writes its marked route blocks into; defaults to proxy/Caddyfile under the Rig state directory.",
            ),
          hostCaddyfile: text
            .optional()
            .describe(
              "Caddyfile the running Caddy loads; it must be the route file or import it. Defaults to the first of /usr/local/etc/Caddyfile, /opt/homebrew/etc/Caddyfile, /etc/caddy/Caddyfile that exists.",
            ),
          extraConfig: z
            .array(text)
            .default([])
            .describe("Extra trusted Caddy site directives."),
          reload: z
            .strictObject({
              mode: z
                .enum(["manual", "command", "disabled"])
                .default("manual")
                .describe("Caddy reload policy."),
              command: text
                .optional()
                .describe(
                  "Explicit Host Caddy reload command; required when mode is command.",
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
        .describe("Caddy provider capability."),
    })
    .prefault({})
    .describe("Provider defaults."),
  web: z
    .strictObject({
      controlPlane: z
        .enum(["localhost", "tailscale", "cloudflare", "disabled"])
        .default("localhost")
        .describe("Control-plane exposure preference."),
      hosted: z
        .strictObject({
          enabled: z
            .boolean()
            .default(false)
            .describe("Enable outbound hosted connection."),
          endpoint: text.optional().describe("Hosted control-plane endpoint."),
          machineId: text.optional().describe("Hosted machine identity."),
          pairingToken: text
            .optional()
            .describe("Secret hosted pairing token."),
        })
        .prefault({})
        .describe("Hosted connection settings."),
    })
    .prefault({})
    .describe("Web control defaults."),
  diagnostics: z
    .strictObject({
      retentionDays: z
        .number()
        .int()
        .min(1)
        .default(14)
        .describe("Diagnostic log retention in days."),
      level: z
        .enum(["debug", "info", "warn", "error"])
        .default("info")
        .describe("Diagnostic verbosity."),
    })
    .prefault({})
    .describe("Rig diagnostic policy."),
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
  const details = issues.map(explainIssue).map((issue) => ({
    path: issue.path.map((part) => safe(String(part))),
    message: safe(issue.message),
  }));
  const hint =
    "Fix " +
    details
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
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
    const nearest = [...issue.errors]
      .filter((branch) => branch.length)
      .sort(
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
